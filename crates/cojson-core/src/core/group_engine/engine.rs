//! Group validation and read-side role resolution over the `NodeCore` registry.
//!
//! This is the Rust port of cojson's permission engine. Two TypeScript
//! algorithms are fused here, exactly as the spec mandates, because they share
//! one accumulation pass:
//!
//! - **Validation** — `determineValidTransactions` /
//!   `determineValidTransactionsForGroup` (`packages/cojson/src/permissions.ts`):
//!   walks a CoValue's transactions in validation order and produces a
//!   [`Verdict`] (valid flag + verbatim TS reason) for every one of them.
//! - **Read-side role resolution** — `RawGroup.roleOfInternal` /
//!   `RawAccount.roleOfInternal` (`packages/cojson/src/coValues/group.ts`,
//!   `account.ts`): answers "what role does `member` have in this group at
//!   time `t`", following time-based parent inheritance.
//!
//! Two role structures are kept, and they are deliberately different (spec:
//! "TWO role structures"):
//!
//! - The **validation-order plain map** (`ResolverState::member_roles`) mirrors
//!   `MemberRoleResolver.memberRoles`. Direct-role lookups here IGNORE time
//!   (`permissions.ts:207-212`); only the parent walk is time-based.
//! - The **time-indexed histories** ([`GroupEngineState::role_history`],
//!   [`GroupEngineState::parent_history`]) mirror the CoMap content /
//!   `parentGroupsChanges` that `roleOfInternal` reads, and are built from
//!   VALIDATED set-role / parent ops only.
//!
//! Builds are always FULL RECOMPUTE (never incremental); a built
//! [`GroupEngineState`] is cached per CoValue and reused only while its
//! per-session transaction counts are unchanged.
//!
//! ## Borrow strategy
//!
//! Recursive engine builds walk from a child group into its parents, and a
//! build must both read many session maps (immutably) and store the engines it
//! computes (mutably). To keep those two borrows disjoint, the engine store
//! lives in a `HashMap<String, GroupEngineState>` that is a SEPARATE field of
//! `NodeCore` from the `covalues: HashMap<String, SessionMapImpl>` map. The
//! algorithms are free functions taking `(&covalues, &mut engines)`, so a
//! `NodeCore` method destructures `self` into its two fields and passes disjoint
//! borrows in. No session map is ever cloned. A single `visited` set guards
//! against build/read re-entrancy on cyclic data (impossible for valid data,
//! since `isSelfExtension` rejects cycles at validation time, but guarded
//! anyway).

use std::collections::{HashMap, HashSet};

use indexmap::IndexMap;

use crate::core::group_engine::classify::{
    account_or_agent_from_write_key_for_member, is_child_extension, is_key_for_account_field,
    is_key_for_key_field, is_key_sealed_for_group_field, is_own_write_key_revelation,
    is_parent_extension, is_write_key_for_member, parent_group_id_from_key,
};
use crate::core::group_engine::tx_view::{
    collect_group_txs_after, collect_group_txs_keyed, sort_for_validation, GroupTxView,
    PendingTxIn, Privacy,
};
use crate::core::group_engine::types::{
    is_higher_role, is_more_permissive_and_should_inherit, ParentRoleMapping, Role, TimeBasedEntry,
};
use crate::core::session_map::{
    CoValueHeader, JsonValue, RulesetDef, SessionMapError, SessionMapImpl,
};

/// The `"everyone"` pseudo-member key (`EVERYONE`, group.ts:49).
const EVERYONE: &str = "everyone";

/// A borrowed view of the node's key store plus its monotonic keys-version,
/// passed by value (Copy) through every engine build / extend / read. Stamping
/// each built [`GroupEngineState`] with the `version` it observed is what closes
/// the F1 key-arrival blind spot: a secret arriving via `provide_key_secret`
/// bumps the node's keys-version, which can change a previously-opaque PRIVATE
/// tx's decrypted META — and thus its `effective_made_at`, merge identity,
/// `is_merge`, and `source_after_current` tamper verdict. Because the suffix
/// predicate reasons over exactly those fields, a keys-version change MUST force
/// a full recompute (never a blind extend). See [`ensure_engine`].
#[derive(Clone, Copy)]
struct KeyCtx<'a> {
    map: &'a HashMap<String, String>,
    version: u64,
}

/// Verbatim TS reason for the merge-meta anti-tamper failure
/// (`coValueCore.ts:1559`). Emitted for any transaction whose merge-derived
/// source made-at is after its own `currentMadeAt`.
const SOURCE_AFTER_CURRENT_REASON: &str = "Transaction sourceMadeAt is after the currentMadeAt";

/// Test-only observability: how many times the incremental fast-path actually
/// EXTENDED a cached engine (as opposed to falling back to a full recompute).
/// The property test asserts this is non-zero so an "incremental == recompute"
/// pass can never be vacuously satisfied by the fast-path never firing.
#[cfg(test)]
pub(crate) static EXTEND_COUNT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

/// The three-way validation result a transaction can land in. Stage 3
/// (`validateTransactions`) adds `ValidBranchPointerOnly` for the ownedByGroup
/// reader branch-pointer special case (permissions.ts:143-156), emitted by
/// [`build_owned_by_group`]. Both `Valid` and `ValidBranchPointerOnly` are
/// non-`Invalid` outcomes, so [`Verdict::valid`] is true for each.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum VerdictOutcome {
    Valid,
    Invalid,
    ValidBranchPointerOnly,
}

impl VerdictOutcome {
    /// The canonical wire string, shared by the napi binding and the fixture
    /// tests — single source of truth, matching the TS union in crypto.ts.
    pub fn as_str(&self) -> &'static str {
        match self {
            VerdictOutcome::Valid => "valid",
            VerdictOutcome::Invalid => "invalid",
            VerdictOutcome::ValidBranchPointerOnly => "validBranchPointerOnly",
        }
    }
}

/// A per-transaction validation verdict, in validation order.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Verdict {
    pub session_id: String,
    pub tx_index: u32,
    /// `outcome != VerdictOutcome::Invalid`, derived once in [`Verdict::new`]
    /// (the sole constructor) so the flag can never drift from `outcome`.
    /// Pre-stage-3 callers that read only `valid`/`reason` are unaffected.
    pub valid: bool,
    pub outcome: VerdictOutcome,
    /// Verbatim TS reason string when invalid; `None` when valid.
    pub reason: Option<String>,
}

impl Verdict {
    /// The ONLY verdict constructor. Derives `valid = outcome !=
    /// VerdictOutcome::Invalid` so the flag can never drift from the outcome
    /// (both non-`Invalid` outcomes — `Valid` and `ValidBranchPointerOnly` —
    /// are valid). A `reason` is required exactly when the outcome is
    /// `Invalid`, and forbidden otherwise (debug-asserted).
    fn new(
        session_id: String,
        tx_index: u32,
        outcome: VerdictOutcome,
        reason: Option<String>,
    ) -> Verdict {
        debug_assert_eq!(
            outcome == VerdictOutcome::Invalid,
            reason.is_some(),
            "an Invalid verdict must carry a reason; a valid one must not"
        );
        Verdict {
            session_id,
            tx_index,
            valid: outcome != VerdictOutcome::Invalid,
            outcome,
            reason,
        }
    }
}

/// The ruleset kind of a CoValue header, plus the facts the engine needs.
/// Stored on [`GroupEngineState`] so the safe incremental fast-path can
/// dispatch without re-reading the header.
#[derive(Debug, Clone, PartialEq, Eq)]
enum RulesetKind {
    Group,
    OwnedByGroup(String),
    UnsafeAllowAll,
}

/// Built by one full validation pass; cached per CoValue keyed by session
/// tx-counts.
pub struct GroupEngineState {
    /// `(session_id, tx_count)` snapshot at build time — the cache-validity key.
    pub session_counts: Vec<(String, u32)>,
    pub verdicts: Vec<Verdict>,
    /// READ state (time-indexed), built from VALIDATED set-role ops only:
    /// member -> role over time (`madeAt` = effective made-at of the op).
    pub role_history: HashMap<String, TimeBasedEntry<Role>>,
    /// parent coId -> mapping over time. `IndexMap` (not the plain `HashMap`
    /// the task sketch shows) so the parent walk iterates in first-appearance
    /// order, matching TS `parentGroupsChanges` Map iteration.
    pub parent_history: IndexMap<String, TimeBasedEntry<ParentRoleMapping>>,
    /// Header ruleset `initialAdmin` (the static agent id for accounts).
    pub initial_admin: Option<String>,
    /// Header `meta.type == "account"` — mirrors `CoValueCore.isGroup()`
    /// distinguishing accounts from plain groups.
    pub is_account: bool,

    // --- Safe incremental-validation cache (R2 write-path fix) ---
    /// The ruleset kind, stored so an ingest can dispatch the incremental
    /// extension without re-reading the header.
    kind: RulesetKind,
    /// The maximum `effective_made_at` over the transactions folded into this
    /// engine. `None` for an empty history. The suffix condition compares each
    /// newly-ingested tx's effective made-at against this: only a tx STRICTLY
    /// greater than every existing one is provably a validation-order suffix.
    max_effective_made_at: Option<u64>,
    /// The terminal [`ResolverState`] of the group fold — the accumulated
    /// member/parent/write-key state after the last transaction in validation
    /// order. Present only for [`RulesetKind::Group`]; the fold is extended from
    /// here when the suffix condition holds. `None` for other rulesets (their
    /// verdicts carry no cross-transaction fold state).
    resolver: Option<ResolverState>,
    /// For [`RulesetKind::OwnedByGroup`]: the owning group's `(session, count)`
    /// snapshot at build time. An owned tx's verdict is a pure function of the
    /// owning group's engine state, so incremental extension is only safe while
    /// that snapshot is unchanged (else the group moved and old owned verdicts
    /// may have flipped — a full recompute picks that up, matching TS).
    owned_group_counts: Option<Vec<(String, u32)>>,
    /// For [`RulesetKind::OwnedByGroup`]: the owning group's engine GENERATION at
    /// build time. Counts alone can miss a parent-group change that reorders the
    /// group's role history without changing its counts — e.g. a key arrival on
    /// the GROUP's own private txs (F5). Any full recompute of the owning group
    /// bumps its generation, so an owned extend also falls back when the group's
    /// generation moved, even if its counts held.
    owned_group_generation: Option<u64>,
    /// The [`KeyCtx::version`] this engine was built against. A change forces a
    /// full recompute (never an extend): a newly-arrived key can re-decrypt an
    /// OLD private tx's meta and flip its effective time / merge identity /
    /// tamper verdict (F1/F3). Compared alongside `session_counts` in
    /// [`ensure_engine`].
    keys_version: u64,
    /// Monotonic generation, bumped ONLY on a full recompute (never on a suffix
    /// extend, which preserves it). Lets a coMap view detect whether the verdict
    /// list was rebuilt-from-scratch since it last materialized. See
    /// [`generation_of`].
    generation: u64,
    /// Accumulated per-transaction PENDING extras (source made-at / source
    /// identity / decrypted private meta) supplied for this CoValue across ALL
    /// ingests since the engine was (re)built — a SPARSE map: only merge/branch/
    /// private-meta-override transactions ever have an entry, so for plain
    /// group/owned/data histories this is empty. Kept resident so the delta
    /// protocol lets TS send pending only for the NEW transactions each pass
    /// (`toValidateTransactions`) while a later FULL recompute (non-suffix ingest
    /// / keys-version change) still folds every historical merge tx with its
    /// original extras — the raw transaction JSON stays the single resident copy
    /// in `SessionMapImpl` (no parsed-view duplication), and only the sparse
    /// pending is re-held here. Upserted by [`merge_pending`] keyed by
    /// `(session_id, tx_index)` (last write wins, matching `collect`'s lookup).
    resident_pending: Vec<PendingTxIn>,
}

/// Upsert `incoming` pending entries into `base`, keyed by `(session_id,
/// tx_index)` — a later entry for the same key REPLACES the earlier one, exactly
/// mirroring the last-write-wins semantics of `collect`'s `pending_by_key`
/// HashMap. Both sides are sparse (only merge/branch/private-meta txs), so this
/// stays cheap even at large histories.
fn merge_pending(base: &mut Vec<PendingTxIn>, incoming: &[PendingTxIn]) {
    for p in incoming {
        if let Some(existing) = base
            .iter_mut()
            .find(|b| b.session_id == p.session_id && b.tx_index == p.tx_index)
        {
            *existing = p.clone();
        } else {
            base.push(p.clone());
        }
    }
}

/// The accumulating state of the group fold — mirrors `MemberRoleResolver`.
/// TS rebuilds this per `determineValidTransactionsForGroup` call; the Rust
/// engine additionally CACHES its terminal value on [`GroupEngineState`] so a
/// suffix-only ingest can extend the fold instead of re-running it (see the
/// safe-incremental note on `try_extend_group_engine`). It is therefore
/// `Clone`.
#[derive(Clone)]
struct ResolverState {
    /// Plain, time-ignoring direct roles (permissions.ts:184-185).
    member_roles: HashMap<String, Role>,
    /// Current non-revoked parent mappings in validation order
    /// (`MemberRoleResolver.parentGroups`); `IndexMap` preserves the TS Map's
    /// insertion order for the parent walk.
    parent_groups: IndexMap<String, ParentRoleMapping>,
    /// member -> KeyID recorded from `writeKeyFor_` ops (last write wins).
    write_only_keys: HashMap<String, String>,
    /// The set of `writeKeyFor_` change keys already seen.
    write_keys: HashSet<String>,
}

impl ResolverState {
    fn new() -> Self {
        ResolverState {
            member_roles: HashMap::new(),
            parent_groups: IndexMap::new(),
            write_only_keys: HashMap::new(),
            write_keys: HashSet::new(),
        }
    }
}

// =====================================================================
// Header facts
// =====================================================================

fn ruleset_kind(header: &CoValueHeader) -> RulesetKind {
    match &header.ruleset {
        RulesetDef::Group(_) => RulesetKind::Group,
        RulesetDef::OwnedByGroup(o) => RulesetKind::OwnedByGroup(o.group.clone()),
        RulesetDef::UnsafeAllowAll(_) => RulesetKind::UnsafeAllowAll,
    }
}

fn initial_admin_of(header: &CoValueHeader) -> Option<String> {
    match &header.ruleset {
        RulesetDef::Group(g) => Some(g.initial_admin.clone()),
        _ => None,
    }
}

/// `header.meta?.type === "account"`.
fn header_meta_is_account(header: &CoValueHeader) -> bool {
    match &header.meta {
        Some(JsonValue::Object(obj)) => {
            matches!(obj.get("type"), Some(JsonValue::String(s)) if s == "account")
        }
        _ => false,
    }
}

/// `CoValueCore.isGroup()` — ruleset is `group` AND not an account
/// (coValueCore.ts:1758-1772).
fn header_is_group(header: &CoValueHeader) -> bool {
    matches!(header.ruleset, RulesetDef::Group(_)) && !header_meta_is_account(header)
}

/// Snapshot of `(session_id, tx_count)` in session-insertion order.
fn session_counts_of(sm: &SessionMapImpl) -> Vec<(String, u32)> {
    sm.get_session_ids()
        .into_iter()
        .map(|sid| {
            let count = sm.get_transaction_count(&sid).unwrap_or(0);
            (sid, count)
        })
        .collect()
}

// =====================================================================
// Change parsing helpers
// =====================================================================

fn change_op(change: &serde_json::Value) -> Option<&str> {
    change.get("op").and_then(|v| v.as_str())
}

fn change_key(change: &serde_json::Value) -> &str {
    change.get("key").and_then(|v| v.as_str()).unwrap_or("")
}

fn change_value_str(change: &serde_json::Value) -> Option<&str> {
    change.get("value").and_then(|v| v.as_str())
}

/// JavaScript truthiness of an optional JSON value, mirroring how TS evaluates
/// `tx.meta?.branch` / `tx.meta?.ownerId` in the reader branch-pointer guard
/// (`permissions.ts:143-147`). A missing key, `null`, `false`, `0`/`NaN`, and
/// the empty string are FALSY; every other string/number, and any array or
/// object, is truthy (JS treats `[]`/`{}` as truthy). The stage-3 fixtures use
/// non-empty string values for both keys, so this only matters for hardening.
fn is_truthy(v: Option<&serde_json::Value>) -> bool {
    match v {
        None | Some(serde_json::Value::Null) => false,
        Some(serde_json::Value::Bool(b)) => *b,
        Some(serde_json::Value::Number(n)) => {
            n.as_f64().map(|f| f != 0.0 && !f.is_nan()).unwrap_or(false)
        }
        Some(serde_json::Value::String(s)) => !s.is_empty(),
        Some(serde_json::Value::Array(_)) | Some(serde_json::Value::Object(_)) => true,
    }
}

/// Parse a `parent_<id>` change value into a [`ParentRoleMapping`].
/// `"extend"`/`"revoked"`/a capped role string. Unrecognized values (never
/// produced by real cojson) yield `None` and are dropped from the read/resolver
/// state while the transaction still validates — see the deviation note in the
/// parent-extension branch.
fn parse_parent_mapping(value: Option<&str>) -> Option<ParentRoleMapping> {
    match value {
        Some("extend") => Some(ParentRoleMapping::Extend),
        Some("revoked") => Some(ParentRoleMapping::Revoked),
        Some(other) => Role::parse(other).map(ParentRoleMapping::Capped),
        None => None,
    }
}

/// Every string the validator accepts as a role value (permissions.ts:424-436).
fn is_valid_role_value(v: Option<&str>) -> bool {
    matches!(
        v,
        Some(
            "admin"
                | "manager"
                | "writer"
                | "reader"
                | "writeOnly"
                | "revoked"
                | "managerInvite"
                | "adminInvite"
                | "writerInvite"
                | "readerInvite"
                | "writeOnlyInvite"
        )
    )
}

// =====================================================================
// Engine freshness / build entry point
// =====================================================================

/// Rebuild `co_id`'s engine into `engines` iff its per-session tx-counts changed
/// since the last build (full recompute). No-op when a fresh engine exists or
/// when `co_id` is already mid-build (`visited` guard, cyclic data only).
fn ensure_engine(
    covalues: &HashMap<String, SessionMapImpl>,
    engines: &mut HashMap<String, GroupEngineState>,
    keys: KeyCtx<'_>,
    co_id: &str,
    pending: &[PendingTxIn],
    visited: &mut HashSet<String>,
) -> Result<(), SessionMapError> {
    let sm = covalues
        .get(co_id)
        .ok_or_else(|| SessionMapError::CoValueNotLoaded(co_id.to_string()))?;

    if let Some(existing) = engines.get(co_id) {
        // The keys-version is part of the freshness key: a key that arrived since
        // this engine was built can change an old private tx's decrypted meta
        // (effective time / merge identity / tamper), so an unchanged count is
        // NOT sufficient to reuse a stale-keys engine (F3).
        if existing.session_counts == session_counts_of(sm) && existing.keys_version == keys.version
        {
            return Ok(());
        }
    }

    // Re-entrant build (only reachable on cyclic parent graphs, which valid data
    // never forms): leave the engine absent; readers treat a missing engine as
    // "no roles", breaking the cycle.
    if visited.contains(co_id) {
        return Ok(());
    }

    // Safe incremental fast-path: if a stale engine exists and the ingest is a
    // provable validation-order SUFFIX, extend the cached fold instead of
    // recomputing from scratch. Extending preserves the engine's `generation`
    // (old verdicts unchanged). Falls back to a full recompute on any doubt.
    //
    // A keys-version change is treated EXACTLY like a suffix-predicate failure:
    // we never extend across it, because the newly-available key can re-decrypt
    // OLD private txs (which the extend does not revisit) and flip their verdicts
    // (F1). Only when the keys-version is unchanged is the extend even attempted.
    if engines.get(co_id).map(|e| e.keys_version) == Some(keys.version)
        && try_extend_engine(covalues, engines, keys, co_id, pending, visited)?
    {
        return Ok(());
    }

    // Full recompute: bump the generation so any coMap view built against an
    // earlier generation knows the verdicts may have been reordered/flipped and
    // must rebuild rather than append.
    let next_generation = engines.get(co_id).map(|e| e.generation).unwrap_or(0) + 1;
    visited.insert(co_id.to_string());
    let state = build_group_engine(covalues, engines, keys, co_id, pending, visited);
    visited.remove(co_id);
    let mut state = state?;
    state.generation = next_generation;
    engines.insert(co_id.to_string(), state);
    Ok(())
}

/// The verdict for one `unsafeAllowAll` transaction: valid, unless the
/// parseMetaInformation anti-tamper override fires (a merge tx back-dated after
/// its own currentMadeAt).
fn unsafe_allow_all_verdict(tx: &GroupTxView) -> Verdict {
    if tx.source_after_current {
        Verdict::new(
            tx.session_id.clone(),
            tx.tx_index,
            VerdictOutcome::Invalid,
            Some(SOURCE_AFTER_CURRENT_REASON.to_string()),
        )
    } else {
        Verdict::new(
            tx.session_id.clone(),
            tx.tx_index,
            VerdictOutcome::Valid,
            None,
        )
    }
}

/// Full recompute of one CoValue's engine. Dispatches on ruleset type exactly as
/// `determineValidTransactions` (permissions.ts:73-169) does.
fn build_group_engine(
    covalues: &HashMap<String, SessionMapImpl>,
    engines: &mut HashMap<String, GroupEngineState>,
    keys: KeyCtx<'_>,
    co_id: &str,
    pending: &[PendingTxIn],
    visited: &mut HashSet<String>,
) -> Result<GroupEngineState, SessionMapError> {
    let sm = covalues
        .get(co_id)
        .ok_or_else(|| SessionMapError::CoValueNotLoaded(co_id.to_string()))?;
    let header = sm.header();
    let kind = ruleset_kind(header);
    let initial_admin = initial_admin_of(header);
    let is_account = header_meta_is_account(header);
    let session_counts = session_counts_of(sm);

    // Accumulate this build's pending onto whatever the prior engine held (still
    // present in `engines` until we reinsert): a full recompute must fold EVERY
    // historical merge/branch tx with its original extras, even when TS supplied
    // pending only for the NEW transactions this pass (the delta protocol). The
    // old engine's `resident_pending` carries the earlier extras forward; the
    // incoming `pending` upserts the new ones. For plain histories both are
    // empty, so this is a no-op clone of an empty Vec.
    let mut resident_pending = engines
        .get(co_id)
        .map(|e| e.resident_pending.clone())
        .unwrap_or_default();
    merge_pending(&mut resident_pending, pending);

    let mut state = GroupEngineState {
        session_counts,
        verdicts: Vec::new(),
        role_history: HashMap::new(),
        parent_history: IndexMap::new(),
        initial_admin: initial_admin.clone(),
        is_account,
        kind: kind.clone(),
        max_effective_made_at: None,
        resolver: None,
        owned_group_counts: None,
        owned_group_generation: None,
        // Stamp the keys-version this build observed; a later change forces a
        // full recompute rather than a blind extend (F1/F3).
        keys_version: keys.version,
        // Set by `ensure_engine` after a full build (extends preserve the prior
        // generation via `engines.remove`/reinsert of the same state).
        generation: 0,
        // Filled in from the local `resident_pending` after the fold below.
        resident_pending: Vec::new(),
    };

    // The fold consults the FULL accumulated pending, not just this pass's slice.
    let pending = resident_pending.as_slice();

    match kind {
        RulesetKind::Group => {
            build_group_ruleset(
                covalues,
                engines,
                keys,
                co_id,
                &mut state,
                sm,
                initial_admin,
                is_account,
                pending,
                visited,
            )?;
        }
        RulesetKind::OwnedByGroup(group_id) => {
            build_owned_by_group(
                covalues, engines, keys, &mut state, sm, &group_id, pending, visited,
            )?;
        }
        RulesetKind::UnsafeAllowAll => {
            // permissions.ts:157-163 — every transaction is valid (modulo the
            // parseMetaInformation anti-tamper override).
            let mut txs = collect_group_txs_keyed(sm, pending, keys.map);
            sort_for_validation(&mut txs);
            for tx in &txs {
                state.max_effective_made_at = Some(
                    state
                        .max_effective_made_at
                        .map_or(tx.effective_made_at, |m| m.max(tx.effective_made_at)),
                );
                state.verdicts.push(unsafe_allow_all_verdict(tx));
            }
        }
    }

    // Re-home the accumulated pending onto the built engine so the next full
    // recompute inherits it (the borrow of it as `pending` above has ended).
    state.resident_pending = resident_pending;
    Ok(state)
}

// =====================================================================
// Group ruleset validation (determineValidTransactionsForGroup)
// =====================================================================

#[allow(clippy::too_many_arguments)]
fn build_group_ruleset(
    covalues: &HashMap<String, SessionMapImpl>,
    engines: &mut HashMap<String, GroupEngineState>,
    keys: KeyCtx<'_>,
    co_id: &str,
    state: &mut GroupEngineState,
    sm: &SessionMapImpl,
    initial_admin: Option<String>,
    is_account: bool,
    pending: &[PendingTxIn],
    visited: &mut HashSet<String>,
) -> Result<(), SessionMapError> {
    let mut txs = collect_group_txs_keyed(sm, pending, keys.map);
    sort_for_validation(&mut txs);

    // `coValue.isGroup()` — a plain group (not an account).
    let is_group = !is_account;
    let initial_admin = initial_admin.unwrap_or_default();

    // Fresh fold state; its terminal value is cached on `state.resolver` after
    // the fold so a later suffix-only ingest can EXTEND it in place instead of
    // recomputing (the write-path fast-path). One shared body — `fold_group_txs`
    // — serves both, so the incremental and full paths cannot drift.
    let mut resolver = ResolverState::new();
    fold_group_txs(
        covalues,
        engines,
        keys,
        co_id,
        state,
        &mut resolver,
        &txs,
        is_group,
        &initial_admin,
        visited,
    )?;
    state.resolver = Some(resolver);
    Ok(())
}

/// Apply `txs` (already in validation order) to the running group fold: push one
/// verdict per transaction, evolve `resolver`, and append to the engine's
/// time-indexed read histories (`role_history`/`parent_history`). Also maintains
/// `state.max_effective_made_at` over every folded transaction (valid or not) —
/// the watermark the suffix condition tests against.
///
/// This is the shared per-transaction body of BOTH the full recompute and the
/// safe incremental extension. The two paths differ only in the starting
/// `resolver` (fresh vs. cached terminal) and the `txs` slice (whole sorted
/// history vs. a proven suffix that sorts strictly after it).
#[allow(clippy::too_many_arguments)]
fn fold_group_txs(
    covalues: &HashMap<String, SessionMapImpl>,
    engines: &mut HashMap<String, GroupEngineState>,
    keys: KeyCtx<'_>,
    co_id: &str,
    state: &mut GroupEngineState,
    resolver: &mut ResolverState,
    txs: &[GroupTxView],
    is_group: bool,
    initial_admin: &str,
    visited: &mut HashSet<String>,
) -> Result<(), SessionMapError> {
    for tx in txs {
        state.max_effective_made_at = Some(
            state
                .max_effective_made_at
                .map_or(tx.effective_made_at, |m| m.max(tx.effective_made_at)),
        );

        // Anti-tamper (parseMetaInformation): a merge tx back-dated to after its
        // own currentMadeAt is invalid, regardless of write permission. Checked
        // first — a tampered merge tx (which real groups never carry as a role
        // change) does not contribute to the fold, which is at least as strict
        // as TS's post-validation `markInvalid` override.
        if tx.source_after_current {
            state.verdicts.push(Verdict::new(
                tx.session_id.clone(),
                tx.tx_index,
                VerdictOutcome::Invalid,
                Some(SOURCE_AFTER_CURRENT_REASON.to_string()),
            ));
            continue;
        }

        let transactor = tx.author.clone();
        let made_at = tx.current_made_at;
        let effective = tx.effective_made_at;

        let transactor_role = resolver_role_at(
            covalues,
            engines,
            keys,
            &*resolver,
            &transactor,
            made_at,
            visited,
        )?;

        macro_rules! verdict {
            (valid) => {{
                state.verdicts.push(Verdict::new(
                    tx.session_id.clone(),
                    tx.tx_index,
                    VerdictOutcome::Valid,
                    None,
                ));
            }};
            (invalid $reason:expr) => {{
                state.verdicts.push(Verdict::new(
                    tx.session_id.clone(),
                    tx.tx_index,
                    VerdictOutcome::Invalid,
                    Some($reason.to_string()),
                ));
            }};
        }

        // --- privacy branch (permissions.ts:250-265) ---
        if tx.privacy == Privacy::Private {
            if is_group {
                verdict!(invalid "Can't make private transactions in groups");
            } else if transactor_role == Some(Role::Admin) {
                verdict!(valid);
            } else {
                verdict!(invalid "Only admins can make private transactions in groups");
            }
            continue;
        }

        // `if (!changes) continue;` (permissions.ts:269-271). Only reachable for
        // a trusting tx whose changes failed to parse (never produced by cojson);
        // no verdict is emitted, matching TS leaving the tx in its prior state.
        let changes = match &tx.changes {
            Some(c) => c,
            None => continue,
        };

        // `change = changes[0]` is read before the length check in TS, but only
        // used afterwards (permissions.ts:273-285).
        if changes.len() != 1 {
            verdict!(invalid "Group transaction must have exactly one change");
            continue;
        }
        let change = &changes[0];

        if change_op(change) != Some("set") {
            verdict!(invalid "Group transaction must set a role or readKey");
            continue;
        }

        let key = change_key(change);

        // --- fixed-key admin-only fields (permissions.ts:292-323) ---
        if key == "readKey" {
            if !Role::can_admin(transactor_role) {
                verdict!(invalid "Only admins can set readKeys");
                continue;
            }
            verdict!(valid);
            continue;
        } else if key == "groupSealer" {
            if !Role::can_admin(transactor_role) {
                verdict!(invalid "Only admins can set groupSealer");
                continue;
            }
            verdict!(valid);
            continue;
        } else if key == "profile" {
            if !Role::can_admin(transactor_role) {
                verdict!(invalid "Only admins can set profile");
                continue;
            }
            verdict!(valid);
            continue;
        } else if key == "root" {
            if !Role::can_admin(transactor_role) {
                verdict!(invalid "Only admins can set root");
                continue;
            }
            verdict!(valid);
            continue;
        } else if is_key_for_key_field(key)
            || is_key_for_account_field(key)
            || is_key_sealed_for_group_field(key)
        {
            // key revelation (permissions.ts:324-344): admins, managers and any
            // invite may reveal; anyone else only their own write key.
            let allowed = matches!(
                transactor_role,
                Some(Role::Admin)
                    | Some(Role::AdminInvite)
                    | Some(Role::Manager)
                    | Some(Role::ManagerInvite)
                    | Some(Role::WriterInvite)
                    | Some(Role::ReaderInvite)
                    | Some(Role::WriteOnlyInvite)
            );
            if !allowed && !is_own_write_key_revelation(key, &transactor, &resolver.write_only_keys)
            {
                verdict!(invalid "Only admins and managers can reveal keys");
                continue;
            }
            verdict!(valid);
            continue;
        } else if is_parent_extension(key) {
            // parent extension (permissions.ts:345-381)
            if !Role::can_admin(transactor_role) {
                verdict!(invalid "Only admins and managers can set parent extensions");
                continue;
            }

            let parent_group_id = parent_group_id_from_key(key).to_string();

            // `expectCoValueLoaded` throwing -> CoValueNotLoaded.
            let parent_sm = covalues
                .get(&parent_group_id)
                .ok_or_else(|| SessionMapError::CoValueNotLoaded(parent_group_id.clone()))?;

            if !header_is_group(parent_sm.header()) {
                verdict!(invalid "Parent group is not a group");
                continue;
            }

            if is_self_extension(covalues, engines, keys, co_id, &parent_group_id, visited)? {
                verdict!(invalid "Parent group is a circular dependency");
                continue;
            }

            // The change value is NOT validated in TS; unrecognized values are
            // stored verbatim. This port drops values it can't map to a
            // `ParentRoleMapping` (extend / revoked / capped role) from both the
            // resolver and the read history, but still marks the tx valid —
            // behaviorally identical for every value real cojson produces.
            match parse_parent_mapping(change_value_str(change)) {
                Some(ParentRoleMapping::Revoked) => {
                    resolver.parent_groups.shift_remove(&parent_group_id);
                    state
                        .parent_history
                        .entry(parent_group_id.clone())
                        .or_default()
                        .add_change(effective, ParentRoleMapping::Revoked);
                }
                Some(mapping) => {
                    resolver
                        .parent_groups
                        .insert(parent_group_id.clone(), mapping);
                    state
                        .parent_history
                        .entry(parent_group_id.clone())
                        .or_default()
                        .add_change(effective, mapping);
                }
                None => {}
            }

            verdict!(valid);
            continue;
        } else if is_child_extension(key) {
            verdict!(invalid "Child extensions are not allowed anymore");
            continue;
        } else if is_write_key_for_member(key) {
            // writeKeyFor_ (permissions.ts:385-418)
            let member_key = account_or_agent_from_write_key_for_member(key).to_string();

            let first_check_fails = transactor_role != Some(Role::Admin)
                && transactor_role != Some(Role::Manager)
                && transactor_role != Some(Role::WriteOnlyInvite)
                && member_key != transactor;
            if first_check_fails {
                verdict!(invalid "Only admins and managers can set writeKeys");
                continue;
            }

            // Assigned on EVERY writeKeyFor_ tx that passes the first check,
            // BEFORE the override check — even for txs the override check then
            // rejects (porter note 6).
            if let Some(v) = change_value_str(change) {
                resolver
                    .write_only_keys
                    .insert(member_key.clone(), v.to_string());
            }

            if resolver.write_keys.contains(key) && !Role::can_admin(transactor_role) {
                verdict!(invalid "Write key already exists and can't be overridden by invite");
                continue;
            }

            resolver.write_keys.insert(key.to_string());
            verdict!(valid);
            continue;
        }

        // --- role assignment (permissions.ts:421-570) ---
        let affected_member = key.to_string();
        let assigned_role_str = change_value_str(change);

        if !is_valid_role_value(assigned_role_str) {
            verdict!(invalid "Group transaction must set a valid role");
            continue;
        }
        let assigned_role = Role::parse(assigned_role_str.unwrap()).unwrap();

        if affected_member == EVERYONE
            && !matches!(
                assigned_role,
                Role::Reader | Role::Writer | Role::WriteOnly | Role::Revoked
            )
        {
            verdict!(invalid "Everyone can only be set to reader, writer, writeOnly or revoked");
            continue;
        }

        // is first self promotion to admin (permissions.ts:468-476)
        if transactor_role.is_none()
            && transactor == initial_admin
            && affected_member == transactor
            && assigned_role == Role::Admin
        {
            resolver
                .member_roles
                .insert(affected_member.clone(), assigned_role);
            state
                .role_history
                .entry(affected_member.clone())
                .or_default()
                .add_change(effective, assigned_role);
            verdict!(valid);
            continue;
        }

        // self revoke is always valid (permissions.ts:478-482)
        if transactor == affected_member && assigned_role == Role::Revoked {
            resolver
                .member_roles
                .insert(affected_member.clone(), assigned_role);
            state
                .role_history
                .entry(affected_member.clone())
                .or_default()
                .add_change(effective, assigned_role);
            verdict!(valid);
            continue;
        }

        let affected_member_role = resolver_role_at(
            covalues,
            engines,
            keys,
            &*resolver,
            &affected_member,
            made_at,
            visited,
        )?;

        // admins (permissions.ts:493-505)
        if transactor_role == Some(Role::Admin) {
            if affected_member_role == Some(Role::Admin)
                && assigned_role != Role::Admin
                && affected_member != transactor
            {
                verdict!(invalid "Admins can't demote admins.");
                continue;
            }
            resolver
                .member_roles
                .insert(affected_member.clone(), assigned_role);
            state
                .role_history
                .entry(affected_member.clone())
                .or_default()
                .add_change(effective, assigned_role);
            verdict!(valid);
            continue;
        }

        // managers (permissions.ts:513-534)
        if transactor_role == Some(Role::Manager) {
            if affected_member_role == Some(Role::Admin) {
                verdict!(invalid "Managers can't demote admins.");
                continue;
            }
            if assigned_role == Role::Admin {
                verdict!(invalid "Managers can't promote to admin.");
                continue;
            }
            if assigned_role == Role::AdminInvite {
                verdict!(invalid "Managers can't invite admins.");
                continue;
            }
            if assigned_role == Role::ManagerInvite {
                verdict!(invalid "Managers can't invite managers.");
                continue;
            }
            resolver
                .member_roles
                .insert(affected_member.clone(), assigned_role);
            state
                .role_history
                .entry(affected_member.clone())
                .or_default()
                .add_change(effective, assigned_role);
            verdict!(valid);
            continue;
        }

        // invites (permissions.ts:536-566)
        let invite_ok = match transactor_role {
            Some(Role::AdminInvite) => {
                if assigned_role != Role::Admin {
                    verdict!(invalid "AdminInvites can only create admins.");
                    continue;
                }
                true
            }
            Some(Role::ManagerInvite) => {
                if assigned_role != Role::Manager {
                    verdict!(invalid "managerInvite can only create managers.");
                    continue;
                }
                true
            }
            Some(Role::WriterInvite) => {
                if assigned_role != Role::Writer {
                    verdict!(invalid "WriterInvites can only create writers.");
                    continue;
                }
                true
            }
            Some(Role::ReaderInvite) => {
                if assigned_role != Role::Reader {
                    verdict!(invalid "ReaderInvites can only create reader.");
                    continue;
                }
                true
            }
            Some(Role::WriteOnlyInvite) => {
                if assigned_role != Role::WriteOnly {
                    verdict!(invalid "WriteOnlyInvites can only create writeOnly.");
                    continue;
                }
                true
            }
            _ => false,
        };

        if !invite_ok {
            verdict!(invalid "Group transaction must be made by current admin, manager, or invite");
            continue;
        }

        resolver
            .member_roles
            .insert(affected_member.clone(), assigned_role);
        state
            .role_history
            .entry(affected_member.clone())
            .or_default()
            .add_change(effective, assigned_role);
        verdict!(valid);
    }

    Ok(())
}

// =====================================================================
// ownedByGroup validation (determineValidTransactions, permissions.ts:90-155)
// =====================================================================

#[allow(clippy::too_many_arguments)]
fn build_owned_by_group(
    covalues: &HashMap<String, SessionMapImpl>,
    engines: &mut HashMap<String, GroupEngineState>,
    keys: KeyCtx<'_>,
    state: &mut GroupEngineState,
    sm: &SessionMapImpl,
    group_id: &str,
    pending: &[PendingTxIn],
    visited: &mut HashSet<String>,
) -> Result<(), SessionMapError> {
    // The owning group must be loaded (expectCoValueLoaded, permissions.ts:92-98).
    ensure_engine(covalues, engines, keys, group_id, &[], visited)?;
    let (group_is_account, group_initial_admin) = engines
        .get(group_id)
        .map(|e| (e.is_account, e.initial_admin.clone()))
        .unwrap_or((false, None));
    // Snapshot the owning group's tx-counts AND engine generation so the
    // incremental fast-path can detect it moving (which can flip already-computed
    // owned verdicts) — counts catch new group txs; the generation additionally
    // catches a same-count group RECOMPUTE (e.g. a key arrival reordering the
    // group's role history, F5).
    state.owned_group_counts = Some(
        covalues
            .get(group_id)
            .map(session_counts_of)
            .unwrap_or_default(),
    );
    state.owned_group_generation = Some(generation_of(engines, group_id));

    // The ownedByGroup branch iterates transactions without the group-validation
    // sort; use collection order (session-insertion, txIndex ascending).
    let txs = collect_group_txs_keyed(sm, pending, keys.map);

    for tx in &txs {
        state.max_effective_made_at = Some(
            state
                .max_effective_made_at
                .map_or(tx.effective_made_at, |m| m.max(tx.effective_made_at)),
        );
        process_owned_tx(
            covalues,
            engines,
            keys,
            state,
            tx,
            group_id,
            group_is_account,
            &group_initial_admin,
            visited,
        )?;
    }

    Ok(())
}

/// Validate ONE ownedByGroup transaction and push its verdict. Shared by the
/// full [`build_owned_by_group`] recompute and the incremental extension: an
/// owned tx's verdict is a pure function of `(tx, owning-group state)` with NO
/// cross-transaction fold, so appending a new tx never disturbs earlier owned
/// verdicts (this is why owned incremental needs no effective-time watermark —
/// only the owning group staying put and collection-order preservation).
#[allow(clippy::too_many_arguments)]
fn process_owned_tx(
    covalues: &HashMap<String, SessionMapImpl>,
    engines: &mut HashMap<String, GroupEngineState>,
    keys: KeyCtx<'_>,
    state: &mut GroupEngineState,
    tx: &GroupTxView,
    group_id: &str,
    group_is_account: bool,
    group_initial_admin: &Option<String>,
    visited: &mut HashSet<String>,
) -> Result<(), SessionMapError> {
    // Anti-tamper (parseMetaInformation): a merge tx whose source made-at is
    // after its own currentMadeAt is invalid. Merge/branch commits are the
    // common ownedByGroup case, so this is where the check most matters.
    if tx.source_after_current {
        state.verdicts.push(Verdict::new(
            tx.session_id.clone(),
            tx.tx_index,
            VerdictOutcome::Invalid,
            Some(SOURCE_AFTER_CURRENT_REASON.to_string()),
        ));
        return Ok(());
    }

    // agentInAccountOrMemberInGroup (permissions.ts:573-581): an account's own
    // id resolves to its static header agent; every other transactor is used
    // as-is (so the "Transactor not found in group" branch is unreachable —
    // this helper never returns undefined).
    let effective_transactor = if tx.author == group_id && group_is_account {
        group_initial_admin
            .clone()
            .unwrap_or_else(|| tx.author.clone())
    } else {
        tx.author.clone()
    };

    let role = role_of_internal(
        covalues,
        engines,
        keys,
        group_id,
        &effective_transactor,
        Some(tx.current_made_at),
        visited,
    )?;

    // The reader branch-pointer special case (permissions.ts:143-156), checked
    // BEFORE the write-permission gate exactly as TS does. The guard is
    // `transactorRoleAtTxTime === "reader" && tx.meta?.branch && tx.meta?.ownerId`:
    // the role must be EXACTLY reader (an admin posting an identically-shaped
    // {branch, ownerId} pointer is NOT trimmed — it has write permission and
    // falls through to a plain Valid), and both meta keys must be JS-truthy (see
    // `is_truthy`). The actual trim (forcing changes/meta to the pointer only)
    // stays in TS; the Rust engine merely classifies the outcome as
    // `ValidBranchPointerOnly`.
    //
    // `tx.meta` is populated from the pending tx's TS-decrypted meta first, then
    // (R2) the NATIVELY-decrypted private-tx meta when the key is held, then the
    // trusting tx's own wire meta (tx_view). Before R2 a received private tx had
    // meta `None` at validation; now, if the key is present, the branch pointer
    // fires natively — see `owned_private_tx_meta_unavailable` (no key) and the
    // R2 private-branch-pointer test.
    let is_reader_branch_pointer = role == Some(Role::Reader)
        && tx
            .meta
            .as_ref()
            .is_some_and(|m| is_truthy(m.get("branch")) && is_truthy(m.get("ownerId")));

    if is_reader_branch_pointer {
        state.verdicts.push(Verdict::new(
            tx.session_id.clone(),
            tx.tx_index,
            VerdictOutcome::ValidBranchPointerOnly,
            None,
        ));
        return Ok(());
    }

    let has_write = matches!(
        role,
        Some(Role::Admin) | Some(Role::Manager) | Some(Role::Writer) | Some(Role::WriteOnly)
    );

    if has_write {
        state.verdicts.push(Verdict::new(
            tx.session_id.clone(),
            tx.tx_index,
            VerdictOutcome::Valid,
            None,
        ));
    } else {
        state.verdicts.push(Verdict::new(
            tx.session_id.clone(),
            tx.tx_index,
            VerdictOutcome::Invalid,
            Some("Transactor has no write permissions".to_string()),
        ));
    }
    Ok(())
}

// =====================================================================
// Safe incremental validation (the write-path fast-path)
// =====================================================================

/// `new_counts` is a pure superset of `old_counts` (no session removed, no
/// per-session count decreased). Both are `(session_id, count)` snapshots.
fn is_pure_superset(old_counts: &[(String, u32)], new_counts: &[(String, u32)]) -> bool {
    let new_map: HashMap<&str, u32> = new_counts.iter().map(|(s, c)| (s.as_str(), *c)).collect();
    old_counts
        .iter()
        .all(|(s, old_c)| new_map.get(s.as_str()).copied().unwrap_or(0) >= *old_c)
}

/// The grown/new sessions form a SUFFIX of the (insertion-ordered) session list:
/// no unchanged old session appears AFTER a session that grew or is new. This is
/// the condition under which appending the new transactions to an
/// insertion-ordered (ownedByGroup) verdict list reproduces a full recompute's
/// collection order. `new_counts` is in session-insertion order.
fn growth_is_suffix(old_counts: &[(String, u32)], new_counts: &[(String, u32)]) -> bool {
    let old_map: HashMap<&str, u32> = old_counts.iter().map(|(s, c)| (s.as_str(), *c)).collect();
    let mut seen_growth = false;
    for (sid, new_c) in new_counts {
        let grew = match old_map.get(sid.as_str()) {
            None => true,                   // brand-new session (appended at the end)
            Some(old_c) => *new_c > *old_c, // existing session that grew
        };
        if grew {
            seen_growth = true;
        } else if seen_growth {
            // An unchanged old session sits after a grown/new one → appending
            // would reorder its verdicts relative to the new ones.
            return false;
        }
    }
    true
}

/// Attempt the safe incremental-validation fast-path for `co_id`. Returns `true`
/// (having extended the cached engine in place) iff the ingest since the cached
/// engine is a provable validation-order SUFFIX; otherwise returns `false` and
/// leaves the cached engine untouched, so the caller full-recomputes.
///
/// ## The suffix condition (exact predicate)
///
/// Let cached engine `E` have been folded over transaction set `Old` with
/// watermark `max_effective = max { effective_made_at(t) : t ∈ Old }`, and let
/// `New` be the transactions ingested since (per-session indices at/after `E`'s
/// counts). The extension is taken IFF ALL hold:
///
/// - **(S1) appends only** — the new per-session counts are a pure superset of
///   `E`'s (no session removed, no count decreased).
/// - **(S2) no re-identifying merge meta** — no tx in `New` carries a merge
///   source identity (`source_session_id`); a merged tx can re-time / re-order
///   into the middle of history, which the fast-path must not assume away.
/// - **(S3) group / unsafeAllowAll — strict time suffix**: every tx in `New` has
///   `effective_made_at` STRICTLY GREATER than `max_effective`. Because
///   `effective_made_at` already folds in any `source_made_at`, this rejects
///   clock-skew / merge-time arrivals that would sort mid-history and could flip
///   an earlier verdict. With this, `New` sorts strictly after all of `Old`, so
///   `Old`'s verdicts are untouched and the group fold merely continues from
///   `E`'s cached terminal `ResolverState`.
/// - **(S4) ownedByGroup — group put + order**: the owning group's tx-counts are
///   unchanged since `E` was built (an owned verdict is a pure function of the
///   group's state; a moved group can flip earlier owned verdicts — full
///   recompute picks that up, matching TS), AND the growth is a suffix of the
///   session insertion order (so appending preserves ownedByGroup's collection
///   order). No time watermark is needed: owned verdicts carry no fold.
///
/// Any doubt → `false`. Conservatism is mandatory: a mid-sequence arrival that
/// flips an earlier verdict MUST fall back (the property test and the
/// out-of-order revocation test pin this).
fn try_extend_engine(
    covalues: &HashMap<String, SessionMapImpl>,
    engines: &mut HashMap<String, GroupEngineState>,
    keys: KeyCtx<'_>,
    co_id: &str,
    pending: &[PendingTxIn],
    visited: &mut HashSet<String>,
) -> Result<bool, SessionMapError> {
    let sm = covalues
        .get(co_id)
        .ok_or_else(|| SessionMapError::CoValueNotLoaded(co_id.to_string()))?;
    let new_counts = session_counts_of(sm);

    // Snapshot the immutable facts we need, then drop the borrow so the engine
    // store is free to be mutated (removed/reinserted, recursed into) below.
    let (old_counts, kind, max_eff, has_resolver, owned_group_counts, owned_group_generation) = {
        let existing = match engines.get(co_id) {
            Some(e) => e,
            None => return Ok(false),
        };
        (
            existing.session_counts.clone(),
            existing.kind.clone(),
            existing.max_effective_made_at,
            existing.resolver.is_some(),
            existing.owned_group_counts.clone(),
            existing.owned_group_generation,
        )
    };

    // (S1) appends only.
    if !is_pure_superset(&old_counts, &new_counts) {
        return Ok(false);
    }

    let old_counts_map: HashMap<String, u32> = old_counts.iter().cloned().collect();
    let new_txs = collect_group_txs_after(sm, pending, &old_counts_map, keys.map);
    if new_txs.is_empty() {
        return Ok(false);
    }

    // (S2) no re-identifying / re-timing source on any new tx. A merged/branched
    // tx (`meta.mi`), a supplied source IDENTITY (`source_session_id`), OR a bare
    // source TIMING of any channel (pending `source_made_at` or native `meta.t`,
    // detectable as `effective_made_at != current_made_at`) can re-time/re-order
    // into the middle of history. The suffix assumption must not paper over ANY
    // of these — a source-timed tx without an identity would otherwise slip past
    // an `is_merge`/`source_session_id`-only check (F2).
    if new_txs.iter().any(|t| {
        t.is_merge || t.source_session_id.is_some() || t.effective_made_at != t.current_made_at
    }) {
        return Ok(false);
    }

    match &kind {
        RulesetKind::Group | RulesetKind::UnsafeAllowAll => {
            // (S3) strict time suffix. An empty `Old` (no watermark) has nothing
            // to reorder into, so any suffix is trivially safe there.
            if let Some(m) = max_eff {
                if !new_txs.iter().all(|t| t.effective_made_at > m) {
                    return Ok(false);
                }
            }
            // A group extension needs the cached terminal fold state.
            if matches!(kind, RulesetKind::Group) && !has_resolver {
                return Ok(false);
            }
        }
        RulesetKind::OwnedByGroup(group_id) => {
            // (S4) owning group unchanged since build. Make the owning group's
            // engine fresh FIRST (it may itself need a recompute — e.g. a key
            // arrived on its private txs), then compare BOTH its counts and its
            // engine GENERATION against the snapshot. Counts catch new group txs;
            // the generation catches a same-count recompute that reordered the
            // group's role history (F5) — either can flip an old owned verdict.
            ensure_engine(covalues, engines, keys, group_id, &[], visited)?;
            let cur_group_counts = covalues
                .get(group_id)
                .map(session_counts_of)
                .unwrap_or_default();
            if owned_group_counts.as_deref() != Some(cur_group_counts.as_slice()) {
                return Ok(false);
            }
            if owned_group_generation != Some(generation_of(engines, group_id)) {
                return Ok(false);
            }
            // (S4) collection-order preservation.
            if !growth_is_suffix(&old_counts, &new_counts) {
                return Ok(false);
            }
        }
    }

    // Guards passed — commit. Take the engine OUT so the fold can recurse into
    // parent engines (which no longer includes `co_id`); `visited` guards
    // re-entrancy exactly as a full build does. On a SessionMapError the engine
    // is dropped (next call rebuilds), matching build's partial-failure posture.
    let mut state = engines
        .remove(co_id)
        .expect("engine present (checked above)");
    // Fold this pass's pending into the resident accumulator so a LATER full
    // recompute still sees every merge/branch tx's extras (the suffix extend
    // itself only needed them for the new txs, already applied via `new_txs`).
    merge_pending(&mut state.resident_pending, pending);
    visited.insert(co_id.to_string());
    let res = extend_engine_state(
        covalues, engines, keys, co_id, &mut state, new_txs, new_counts, visited,
    );
    visited.remove(co_id);
    res?;
    engines.insert(co_id.to_string(), state);
    Ok(true)
}

/// Extend a cached engine `state` with the proven-suffix `new_txs`, dispatching
/// on ruleset. Shares the exact per-transaction bodies of the full recompute
/// (`fold_group_txs` / `process_owned_tx`), so an extension is verdict-for-verdict
/// identical to a from-scratch build over the same total history.
#[allow(clippy::too_many_arguments)]
fn extend_engine_state(
    covalues: &HashMap<String, SessionMapImpl>,
    engines: &mut HashMap<String, GroupEngineState>,
    keys: KeyCtx<'_>,
    co_id: &str,
    state: &mut GroupEngineState,
    new_txs: Vec<GroupTxView>,
    new_counts: Vec<(String, u32)>,
    visited: &mut HashSet<String>,
) -> Result<(), SessionMapError> {
    #[cfg(test)]
    EXTEND_COUNT.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    // Load-bearing invariant for the group / unsafeAllowAll arms below: S3
    // proved every new tx's `effective_made_at` is STRICTLY greater than the
    // cached watermark, so sorting the suffix IN ISOLATION and appending it
    // reproduces exactly the tail a global re-sort of the whole history would
    // produce (nothing new can sort before an old tx). If a future refactor ever
    // weakened S3's strict `>` to `>=`, a cross-session equal-time tx could sort
    // BEFORE an old tx under a global sort while the isolated sort still appends
    // it — silently corrupting verdict order. This debug-assert pins the
    // dependency so such a regression fails the tests loudly (F4).
    debug_assert!(
        matches!(state.kind, RulesetKind::OwnedByGroup(_))
            || state
                .max_effective_made_at
                .is_none_or(|m| new_txs.iter().all(|t| t.effective_made_at > m)),
        "extend suffix must be strictly after the cached watermark (S3)"
    );
    match state.kind.clone() {
        RulesetKind::UnsafeAllowAll => {
            let mut txs = new_txs;
            sort_for_validation(&mut txs);
            for tx in &txs {
                state.max_effective_made_at = Some(
                    state
                        .max_effective_made_at
                        .map_or(tx.effective_made_at, |m| m.max(tx.effective_made_at)),
                );
                state.verdicts.push(unsafe_allow_all_verdict(tx));
            }
        }
        RulesetKind::Group => {
            let mut txs = new_txs;
            sort_for_validation(&mut txs);
            let is_group = !state.is_account;
            let initial_admin = state.initial_admin.clone().unwrap_or_default();
            // The cached terminal fold state is the starting point (guarded
            // present by `has_resolver`); re-cache the new terminal after.
            let mut resolver = state
                .resolver
                .take()
                .expect("group resolver cached (guarded in try_extend_engine)");
            fold_group_txs(
                covalues,
                engines,
                keys,
                co_id,
                state,
                &mut resolver,
                &txs,
                is_group,
                &initial_admin,
                visited,
            )?;
            state.resolver = Some(resolver);
        }
        RulesetKind::OwnedByGroup(group_id) => {
            // Owned txs stay in collection order (no sort). The owning group is
            // guaranteed unchanged (S4), but re-ensure + refresh the snapshot so
            // the engine stays self-consistent.
            ensure_engine(covalues, engines, keys, &group_id, &[], visited)?;
            let (group_is_account, group_initial_admin) = engines
                .get(&group_id)
                .map(|e| (e.is_account, e.initial_admin.clone()))
                .unwrap_or((false, None));
            state.owned_group_counts = Some(
                covalues
                    .get(&group_id)
                    .map(session_counts_of)
                    .unwrap_or_default(),
            );
            state.owned_group_generation = Some(generation_of(engines, &group_id));
            for tx in &new_txs {
                state.max_effective_made_at = Some(
                    state
                        .max_effective_made_at
                        .map_or(tx.effective_made_at, |m| m.max(tx.effective_made_at)),
                );
                process_owned_tx(
                    covalues,
                    engines,
                    keys,
                    state,
                    tx,
                    &group_id,
                    group_is_account,
                    &group_initial_admin,
                    visited,
                )?;
            }
        }
    }
    state.session_counts = new_counts;
    Ok(())
}

// =====================================================================
// Validation-side role resolution (MemberRoleResolver.getRoleAtTime)
// =====================================================================

/// `MemberRoleResolver.getRoleAtTime` (permissions.ts:207-226). The direct role
/// comes from the plain, time-ignoring map; each parent contributes its
/// time-based read-side role, capped/extended per its mapping and upgraded via
/// the validation comparator.
fn resolver_role_at(
    covalues: &HashMap<String, SessionMapImpl>,
    engines: &mut HashMap<String, GroupEngineState>,
    keys: KeyCtx<'_>,
    resolver: &ResolverState,
    member: &str,
    time: u64,
    visited: &mut HashSet<String>,
) -> Result<Option<Role>, SessionMapError> {
    let mut role = resolver.member_roles.get(member).copied();

    for (parent_id, mapping) in &resolver.parent_groups {
        // Cyclic-data guard: an in-progress parent contributes nothing.
        if visited.contains(parent_id) {
            continue;
        }
        let parent_role = role_of_internal(
            covalues,
            engines,
            keys,
            parent_id,
            member,
            Some(time),
            visited,
        )?;

        if !Role::is_inheritable(parent_role) {
            continue;
        }

        let resolved = match mapping {
            ParentRoleMapping::Extend => parent_role.unwrap(),
            ParentRoleMapping::Capped(r) => *r,
            // Revoked mappings are never present in `parent_groups` (removed on
            // revoke); listed for exhaustiveness.
            ParentRoleMapping::Revoked => continue,
        };

        if is_higher_role(resolved, role) {
            role = Some(resolved);
        }
    }

    Ok(role)
}

// =====================================================================
// Read-side role resolution (RawGroup/RawAccount.roleOfInternal)
// =====================================================================

/// Read-side role of `member` in `group_id` at `at_time` (`None` = latest).
///
/// Port of `RawGroup.roleOfInternal` (group.ts:451-488) plus the `RawAccount`
/// overrides (account.ts:68-75). Builds the group's engine (and, recursively,
/// its parents') on demand.
fn role_of_internal(
    covalues: &HashMap<String, SessionMapImpl>,
    engines: &mut HashMap<String, GroupEngineState>,
    keys: KeyCtx<'_>,
    group_id: &str,
    member: &str,
    at_time: Option<u64>,
    visited: &mut HashSet<String>,
) -> Result<Option<Role>, SessionMapError> {
    ensure_engine(covalues, engines, keys, group_id, &[], visited)?;

    // Missing engine == cyclic build in progress: treat as no roles.
    let engine = match engines.get(group_id) {
        Some(e) => e,
        None => return Ok(None),
    };

    // RawAccount override (account.ts:68-75): self is always admin.
    if engine.is_account && member == group_id {
        return Ok(Some(Role::Admin));
    }

    // Direct role; a direct `revoked` collapses to `undefined` here
    // (group.ts:454-458).
    let mut role_info = match engine.role_history.get(member) {
        Some(hist) => match hist.get_at_time(at_time) {
            Some(Role::Revoked) | None => None,
            Some(r) => Some(*r),
        },
        None => None,
    };

    // Parent walk (group.ts:462-479). Collect the parent edges first so the
    // engines map is free to be mutated by the recursion.
    let parent_edges: Vec<(String, ParentRoleMapping)> = engine
        .parent_history
        .iter()
        .filter_map(|(pid, hist)| match hist.get_at_time(at_time) {
            Some(ParentRoleMapping::Revoked) | None => None,
            Some(mapping) => Some((pid.clone(), *mapping)),
        })
        .collect();

    for (parent_id, mapping) in parent_edges {
        // Cycle guard: skip an edge back into a group we are already resolving.
        if visited.contains(&parent_id) {
            continue;
        }
        let parent_role = role_of_internal(
            covalues, engines, keys, &parent_id, member, at_time, visited,
        )?;

        if !Role::is_inheritable(parent_role) {
            continue;
        }

        let role_to_inherit = match mapping {
            ParentRoleMapping::Extend => parent_role.unwrap(),
            ParentRoleMapping::Capped(r) => r,
            ParentRoleMapping::Revoked => continue,
        };

        if is_more_permissive_and_should_inherit(role_to_inherit, role_info) {
            role_info = Some(role_to_inherit);
        }
    }

    // Everyone fallback (group.ts:481-485) — only when no role resolved and the
    // query itself is not for "everyone".
    if role_info.is_none() && member != EVERYONE {
        // Re-borrow: the recursion above may have rebuilt/replaced the engine.
        if let Some(engine) = engines.get(group_id) {
            if let Some(hist) = engine.role_history.get(EVERYONE) {
                match hist.get_at_time(at_time) {
                    Some(Role::Revoked) | None => {}
                    Some(r) => return Ok(Some(*r)),
                }
            }
        }
    }

    Ok(role_info)
}

// =====================================================================
// isSelfExtension (group.ts:1766-1791)
// =====================================================================

/// `isSelfExtension` (group.ts:1766-1791): stack walk from the candidate
/// `parent_id` over each group's CURRENT (latest, non-revoked) parent mappings;
/// returns true if the child's own id is reached (including `parent_id ==
/// child_id`, a direct self-reference).
fn is_self_extension(
    covalues: &HashMap<String, SessionMapImpl>,
    engines: &mut HashMap<String, GroupEngineState>,
    keys: KeyCtx<'_>,
    child_id: &str,
    parent_id: &str,
    visited: &mut HashSet<String>,
) -> Result<bool, SessionMapError> {
    let mut checked: HashSet<String> = HashSet::new();
    let mut queue: Vec<String> = vec![parent_id.to_string()];

    while let Some(current) = queue.pop() {
        if current == child_id {
            return Ok(true);
        }
        if !checked.insert(current.clone()) {
            continue;
        }

        // getParentGroups() on `current` requires it loaded and needs its engine
        // for the current parent mappings.
        ensure_engine(covalues, engines, keys, &current, &[], visited)?;
        let parents: Vec<String> = match engines.get(&current) {
            Some(e) => e
                .parent_history
                .iter()
                .filter_map(|(pid, hist)| match hist.get_at_time(None) {
                    Some(ParentRoleMapping::Revoked) | None => None,
                    Some(_) => Some(pid.clone()),
                })
                .collect(),
            None => Vec::new(),
        };

        for pid in parents {
            if !checked.contains(&pid) {
                queue.push(pid);
            }
        }
    }

    Ok(false)
}

// =====================================================================
// NodeCore-facing entry points
// =====================================================================

/// Validate every transaction of `co_id` and return the verdicts in validation
/// order. Operates on `NodeCore`'s disjoint field borrows. (Stage 2 name:
/// `validate_group`; renamed here as Stage 3's unified `validateTransactions`
/// surface, which subsumes it and adds the `ValidBranchPointerOnly` outcome.)
pub fn validate_transactions(
    covalues: &HashMap<String, SessionMapImpl>,
    engines: &mut HashMap<String, GroupEngineState>,
    keys: &HashMap<String, String>,
    keys_version: u64,
    co_id: &str,
    pending: &[PendingTxIn],
) -> Result<Vec<Verdict>, SessionMapError> {
    let mut visited = HashSet::new();
    let keys = KeyCtx {
        map: keys,
        version: keys_version,
    };
    ensure_engine(covalues, engines, keys, co_id, pending, &mut visited)?;
    Ok(engines
        .get(co_id)
        .map(|e| e.verdicts.clone())
        .unwrap_or_default())
}

/// A DELTA of validation verdicts: the tail of the verdict list a caller has not
/// yet seen, tagged with the engine's [`generation`](GroupEngineState::generation)
/// so the caller can pair it with its own cursor.
#[derive(Debug, Clone)]
pub struct VerdictDelta {
    /// The engine's current full-recompute generation (see [`generation_of`]).
    pub generation: u64,
    /// The index into the FULL verdict list at which `verdicts` begins. `0` when
    /// the whole list is returned (a recompute happened, or the caller's cursor
    /// did not match); `since_count` when only the appended tail is returned.
    pub from_index: u32,
    /// The verdicts from `from_index` onward, in validation order.
    pub verdicts: Vec<Verdict>,
}

/// Delta-returning counterpart of [`validate_transactions`]. Ensures the engine
/// is fresh, then returns ONLY the verdicts the caller has not seen:
///
/// - **Generation MATCH** (`generation == since_generation`, and the caller's
///   `since_count` is within the current list): no full recompute has happened
///   since the caller's cursor, so — by the engine's generation contract — the
///   verdicts at `[0..since_count]` are byte-for-byte unchanged (an extend only
///   ever APPENDS; it never reorders or flips an already-emitted verdict). Return
///   `verdicts[since_count..]` with `from_index = since_count`. Marshalling and
///   TS re-apply then cost O(new), not O(history).
/// - **Generation MISMATCH** (a recompute reordered/flipped verdicts, or the
///   caller has no cursor): return the FULL list with `from_index = 0`, so the
///   caller resets its cursor and re-applies every verdict (flips reach old txs).
///
/// The pairing is sound because generation is MONOTONIC within an engine's
/// lifetime (bumped on every full recompute, preserved across every extend) and
/// the caller invalidates its cursor in lockstep with the ONE place the engine is
/// dropped (TS `resetParsedTransactions` → `reset_validation`), so a match can
/// never coincide with a stale-but-changed verdict prefix.
#[allow(clippy::too_many_arguments)]
pub fn validate_transactions_delta(
    covalues: &HashMap<String, SessionMapImpl>,
    engines: &mut HashMap<String, GroupEngineState>,
    keys: &HashMap<String, String>,
    keys_version: u64,
    co_id: &str,
    since_generation: u64,
    since_count: u32,
    pending: &[PendingTxIn],
) -> Result<VerdictDelta, SessionMapError> {
    let mut visited = HashSet::new();
    let keys = KeyCtx {
        map: keys,
        version: keys_version,
    };
    ensure_engine(covalues, engines, keys, co_id, pending, &mut visited)?;
    let (generation, verdicts) = engines
        .get(co_id)
        .map(|e| (e.generation, e.verdicts.as_slice()))
        .unwrap_or((0, &[]));

    let since = since_count as usize;
    if generation == since_generation && since <= verdicts.len() {
        Ok(VerdictDelta {
            generation,
            from_index: since_count,
            verdicts: verdicts[since..].to_vec(),
        })
    } else {
        Ok(VerdictDelta {
            generation,
            from_index: 0,
            verdicts: verdicts.to_vec(),
        })
    }
}

/// Ensure `co_id`'s engine is fresh (extending or recomputing as needed)
/// WITHOUT cloning the verdicts out. Callers in-crate (coMap materialization)
/// then borrow `engines[co_id].verdicts` directly, avoiding an O(n) verdict
/// clone on every ingest — the difference between a linear and a quadratic
/// write path.
pub fn ensure(
    covalues: &HashMap<String, SessionMapImpl>,
    engines: &mut HashMap<String, GroupEngineState>,
    keys: &HashMap<String, String>,
    keys_version: u64,
    co_id: &str,
    pending: &[PendingTxIn],
) -> Result<(), SessionMapError> {
    let mut visited = HashSet::new();
    let keys = KeyCtx {
        map: keys,
        version: keys_version,
    };
    ensure_engine(covalues, engines, keys, co_id, pending, &mut visited)
}

/// The cached verdicts for `co_id` (empty slice if no engine). Pair with
/// [`ensure`] after making the engine fresh.
pub fn verdicts_of<'a>(
    engines: &'a HashMap<String, GroupEngineState>,
    co_id: &str,
) -> &'a [Verdict] {
    engines
        .get(co_id)
        .map(|e| e.verdicts.as_slice())
        .unwrap_or(&[])
}

/// The engine's full-recompute GENERATION for `co_id` (`0` if no engine). Bumped
/// only when the verdicts are rebuilt from scratch — never on a suffix extend —
/// so a coMap view can tell "only appends happened since I last materialized"
/// (same generation → safe to append) from "a recompute may have reordered
/// verdicts" (generation changed → must rebuild).
pub fn generation_of(engines: &HashMap<String, GroupEngineState>, co_id: &str) -> u64 {
    engines.get(co_id).map(|e| e.generation).unwrap_or(0)
}

/// Read-side role of `member` in `group_id` at `at_time`.
pub fn role_of(
    covalues: &HashMap<String, SessionMapImpl>,
    engines: &mut HashMap<String, GroupEngineState>,
    keys: &HashMap<String, String>,
    keys_version: u64,
    group_id: &str,
    member: &str,
    at_time: Option<u64>,
) -> Result<Option<Role>, SessionMapError> {
    let mut visited = HashSet::new();
    let keys = KeyCtx {
        map: keys,
        version: keys_version,
    };
    role_of_internal(
        covalues,
        engines,
        keys,
        group_id,
        member,
        at_time,
        &mut visited,
    )
}

// =====================================================================
// Fixture tests — the main gate. One test per `data/group_engine/*.json`.
// =====================================================================

#[cfg(test)]
mod tests {
    use super::Verdict;
    use crate::core::group_engine::tx_view::fixtures::{build_session_map, FixtureFile};
    use crate::core::node::NodeCore;

    /// `(session_id, tx_index) -> madeAt` from a fixture's raw transactions.
    fn made_at_index(fix: &FixtureFile) -> std::collections::HashMap<(String, u32), u64> {
        let mut m = std::collections::HashMap::new();
        for cov in &fix.covalues {
            for s in &cov.sessions {
                for (i, raw) in s.transactions.iter().enumerate() {
                    let v: serde_json::Value = serde_json::from_str(raw).unwrap();
                    let made = v.get("madeAt").and_then(|x| x.as_u64()).unwrap_or(0);
                    m.insert((s.session_id.clone(), i as u32), made);
                }
            }
        }
        m
    }

    /// Load a fixture into a `NodeCore`, then assert every verdict list and every
    /// role query matches EXACTLY (valid flag + verbatim reason string + role).
    ///
    /// Verdict ORDER is asserted up to the comparator's own ambiguity: cross-session
    /// transactions sharing a `madeAt` are `Equal` under `compareTransactions`
    /// (coValueCore.ts:1851-1855), so their relative order is unspecified. The check
    /// therefore requires (a) an identical `madeAt` sequence and (b) an identical set
    /// of verdicts within each equal-`madeAt` group — pinning validity, reason, and
    /// the fully-ordered part of the sequence, while allowing equal-`madeAt`
    /// cross-session ties to differ. See the report's ordering note.
    /// Load every covalue of a fixture into a fresh `NodeCore`, mirroring the
    /// standalone fixture builder (create + transaction replay under
    /// skip_verify). Shared by `run_fixture` and the dedicated stage-3 tests.
    fn load_fixture_node(name: &str, fix: &FixtureFile) -> NodeCore {
        let mut node = NodeCore::new();
        for cov in &fix.covalues {
            // Reuse the shared builder to stay identical to the tx_view tests,
            // then splice it in via a fresh create + transaction replay.
            let _ = build_session_map(cov); // sanity: header + txs parse under skip_verify
            node.create_co_value(&cov.co_id, &cov.header_json, None, true)
                .unwrap_or_else(|e| panic!("[{name}] create {}: {e}", cov.co_id));
            for session in &cov.sessions {
                let txs_json = format!("[{}]", session.transactions.join(","));
                node.get_mut(&cov.co_id)
                    .unwrap()
                    .add_transactions(
                        &session.session_id,
                        None,
                        &txs_json,
                        &session.last_signature,
                        true,
                    )
                    .unwrap_or_else(|e| panic!("[{name}] add txs {}: {e}", session.session_id));
            }
        }
        node
    }

    fn run_fixture(name: &str) {
        let fix = FixtureFile::load(name);
        let made_at = made_at_index(&fix);

        // Build each covalue's session map exactly as the standalone fixture
        // helper does, but inside the node's registry.
        let mut node = load_fixture_node(name, &fix);

        // Verdicts: one validate_transactions call per verdict-bearing covalue.
        for (co_id, expected) in &fix.verdicts {
            let got = node
                .validate_transactions(co_id, &[])
                .unwrap_or_else(|e| panic!("[{name}] validate_transactions {co_id}: {e}"));
            assert_eq!(
                got.len(),
                expected.len(),
                "[{name}] verdict count mismatch for {co_id}\n got: {got:#?}"
            );

            // (a) identical madeAt sequence (the fully-ordered part of the order).
            for (i, (g, e)) in got.iter().zip(expected.iter()).enumerate() {
                let gm = made_at[&(g.session_id.clone(), g.tx_index)];
                let em = made_at[&(e.session_id.clone(), e.tx_index)];
                assert!(
                    gm == em,
                    "[{name}] verdict madeAt-sequence mismatch at #{i} for {co_id}: \
                     got {gm} ({} #{}), expected {em} ({} #{})",
                    g.session_id,
                    g.tx_index,
                    e.session_id,
                    e.tx_index
                );
            }

            // (b) identical verdict set within each equal-madeAt group. The
            // comparison honors the stage-3 `outcome` field: got's
            // `VerdictOutcome` is compared as its wire string, and an expected
            // verdict with no `outcome` derives it from `valid` (valid ->
            // "valid", invalid -> "invalid") so pre-stage-3 fixtures are
            // unaffected while `validBranchPointerOnly` is pinned exactly.
            let outcome_str = |o: super::VerdictOutcome| o.as_str();
            let key = |v: &Verdict| {
                (
                    made_at[&(v.session_id.clone(), v.tx_index)],
                    v.session_id.clone(),
                    v.tx_index,
                    v.valid,
                    v.reason.clone(),
                    outcome_str(v.outcome).to_string(),
                )
            };
            let mut gs: Vec<_> = got.iter().map(key).collect();
            let mut es: Vec<_> = expected
                .iter()
                .map(|e| {
                    let outcome = e
                        .outcome
                        .clone()
                        .unwrap_or_else(|| if e.valid { "valid" } else { "invalid" }.to_string());
                    (
                        made_at[&(e.session_id.clone(), e.tx_index)],
                        e.session_id.clone(),
                        e.tx_index,
                        e.valid,
                        e.reason.clone(),
                        outcome,
                    )
                })
                .collect();
            gs.sort();
            es.sort();
            assert_eq!(gs, es, "[{name}] verdict set mismatch for {co_id}");
        }

        // Role queries.
        for q in &fix.role_queries {
            let got = node
                .role_of(&q.group_id, &q.member, q.at_time)
                .unwrap_or_else(|e| panic!("[{name}] role_of {} {}: {e}", q.group_id, q.member));
            let got_str = got.map(|r| r.as_str().to_string());
            assert_eq!(
                got_str.as_deref(),
                q.expected_role.as_deref(),
                "[{name}] role query group={} member={} atTime={:?}",
                q.group_id,
                q.member,
                q.at_time
            );
        }
    }

    macro_rules! fixture_test {
        ($fn_name:ident, $file:literal) => {
            #[test]
            fn $fn_name() {
                run_fixture($file);
            }
        };
    }

    fixture_test!(account_agent_resolution, "account_agent_resolution");
    fixture_test!(admin_demotion_rules, "admin_demotion_rules");
    fixture_test!(all_invites, "all_invites");
    fixture_test!(basic_roles, "basic_roles");
    fixture_test!(cross_session_ties, "cross_session_ties");
    fixture_test!(deep_parent_chain, "deep_parent_chain");
    fixture_test!(everyone_roles, "everyone_roles");
    fixture_test!(initial_admin_self_promotion, "initial_admin_self_promotion");
    fixture_test!(key_revelations, "key_revelations");
    fixture_test!(malformed_changes, "malformed_changes");
    fixture_test!(manager_rules, "manager_rules");
    fixture_test!(parent_capped, "parent_capped");
    fixture_test!(parent_extend, "parent_extend");
    fixture_test!(parent_revoked_inheritance, "parent_revoked_inheritance");
    fixture_test!(private_tx_in_group, "private_tx_in_group");
    fixture_test!(self_extension_cycle, "self_extension_cycle");
    fixture_test!(self_revoke, "self_revoke");
    fixture_test!(write_only_keys, "write_only_keys");

    // --- Stage 3: ownedByGroup / account / unsafeAllowAll + branch pointer ---
    fixture_test!(unsafe_allow_all, "unsafe_allow_all");
    fixture_test!(owned_by_account, "owned_by_account");
    fixture_test!(owned_by_group_roles, "owned_by_group_roles");
    fixture_test!(
        owned_by_group_role_change_over_time,
        "owned_by_group_role_change_over_time"
    );
    fixture_test!(owned_reader_branch_pointer, "owned_reader_branch_pointer");
    fixture_test!(
        owned_private_tx_meta_unavailable,
        "owned_private_tx_meta_unavailable"
    );

    // =====================================================================
    // merged_tx_ties: the admin branch-pointer COUNTER-case + all-valid multiset
    // =====================================================================

    /// `merged_tx_ties` (ownedByGroup) — every transaction is authored by the
    /// group's admin. One of them carries an `{branch, ownerId}` meta that is
    /// shape-identical to the reader branch-pointer trim's input; because the
    /// author is admin (NOT reader), the reader trim must NOT fire. This pins
    /// (a) the documented all-valid multiset and (b) that NO verdict is
    /// `ValidBranchPointerOnly` — the trim's `role == reader` guard.
    #[test]
    fn merged_tx_ties_admin_branch_pointer_is_not_trimmed() {
        use super::VerdictOutcome;
        use crate::core::group_engine::tx_view::PendingTxIn;

        let owned_id = "co_zSKK5oFqS8LcD3Rj14nYJQf5S6B";
        let fix = FixtureFile::load("merged_tx_ties");
        let mut node = load_fixture_node("merged_tx_ties", &fix);

        // The owning group's id — used as a truthy `ownerId` for the pointer.
        let group_id = "co_zQRoiJcPP4nRGqf8bnMWoxYJkZH";
        // The single admin session of the owned covalue.
        let admin_session = fix
            .covalues
            .iter()
            .find(|c| c.co_id == owned_id)
            .expect("owned covalue present")
            .sessions[0]
            .session_id
            .clone();

        // Force branch-pointer meta onto the (private) tx #1 so the trim's meta
        // precondition is satisfied; only the admin-vs-reader role must then
        // decide the outcome.
        let pending = vec![PendingTxIn {
            session_id: admin_session.clone(),
            tx_index: 1,
            source_made_at: None,
            meta_json: Some(format!(
                r#"{{"branch":"feature-branch","ownerId":"{group_id}"}}"#
            )),
            source_tx_id: None,
        }];

        let got = node
            .validate_transactions(owned_id, &pending)
            .expect("validate merged_tx_ties");

        assert_eq!(got.len(), 5, "5 transactions in the owned covalue");
        assert!(
            got.iter().all(|v| v.valid),
            "every merged_tx_ties transaction is valid (admin-authored): {got:#?}"
        );
        assert!(
            got.iter()
                .all(|v| v.outcome != VerdictOutcome::ValidBranchPointerOnly),
            "an admin's identically-shaped branch pointer must stay plain Valid, \
             never validBranchPointerOnly: {got:#?}"
        );
    }

    // =====================================================================
    // reset_validation: drop the cached engine, forcing a rebuild
    // =====================================================================

    /// `reset_validation` must drop the cached engine so the NEXT validate
    /// rebuilds with fresh inputs. Probe (behavioral, no counter): the engine
    /// cache is keyed by per-session tx-counts and IGNORES `pending`, so a
    /// second `validate_transactions` with changed `pending` normally hits the
    /// cache and returns the stale verdicts. `reset_validation` between the two
    /// calls forces the rebuild, letting the new pending meta take effect —
    /// flipping a reader's private write from "no write permissions" to the
    /// branch-pointer outcome.
    ///
    /// Also asserts the absent-id no-op contract.
    #[test]
    fn reset_validation_forces_rebuild_with_fresh_pending() {
        use super::VerdictOutcome;
        use crate::core::group_engine::tx_view::PendingTxIn;

        let owned_id = "co_zaNLWDF81o7S9DV94nkS9NPhLTE";
        // The reader's PRIVATE tx — meta is unavailable at validation, so it is
        // rejected until decrypted meta is supplied as pending.
        let private_session = "co_zb63hTq7sRoA9bULJuhYkkD3Ytc_session_zFf61jGJyWoS";
        let owner_group = "co_z95CafWcqPaQiGCj9YiF3QyGPrN";

        let fix = FixtureFile::load("owned_private_tx_meta_unavailable");
        let mut node = load_fixture_node("owned_private_tx_meta_unavailable", &fix);

        let private_verdict = |verdicts: &[Verdict]| -> Verdict {
            verdicts
                .iter()
                .find(|v| v.session_id == private_session && v.tx_index == 0)
                .expect("private tx verdict present")
                .clone()
        };

        // 1) Baseline: no pending meta -> reader's private write is rejected.
        let base = node.validate_transactions(owned_id, &[]).unwrap();
        assert!(
            !private_verdict(&base).valid,
            "private write rejected without meta"
        );

        // Branch-pointer meta the reader "intended" — visible only once decrypted.
        let pending = vec![PendingTxIn {
            session_id: private_session.to_string(),
            tx_index: 0,
            source_made_at: None,
            meta_json: Some(format!(
                r#"{{"branch":"feature-branch","ownerId":"{owner_group}"}}"#
            )),
            source_tx_id: None,
        }];

        // 2) Same node, NEW pending, but NO reset -> cache hit ignores pending.
        let cached = node.validate_transactions(owned_id, &pending).unwrap();
        assert!(
            !private_verdict(&cached).valid,
            "without reset, the cached engine ignores the new pending meta"
        );

        // 3) reset_validation -> the next validate rebuilds and sees the pending.
        node.reset_validation(owned_id);
        let rebuilt = node.validate_transactions(owned_id, &pending).unwrap();
        let v = private_verdict(&rebuilt);
        assert!(v.valid, "after reset, the branch pointer is honored");
        assert_eq!(
            v.outcome,
            VerdictOutcome::ValidBranchPointerOnly,
            "reader + branch-pointer meta -> validBranchPointerOnly after rebuild"
        );

        // Absent-id contract: no-op, no panic.
        node.reset_validation("co_zNeverRegistered");
    }

    // =====================================================================
    // Error taxonomy: UnknownCoValue (primary) vs CoValueNotLoaded (dependency)
    // =====================================================================

    /// An unregistered PRIMARY coId passed directly to a coId-first entry point
    /// is API misuse — `UnknownCoValue` — matching every other `NodeCore`
    /// method (e.g. `get`/`get_mut`). It must NOT surface as
    /// `CoValueNotLoaded`, which is reserved for dependencies (parent groups /
    /// owning accounts) discovered missing during a recursive build.
    #[test]
    fn validate_transactions_unknown_primary_errors() {
        use crate::core::session_map::SessionMapError;

        let mut node = NodeCore::new();

        match node.validate_transactions("co_zNope", &[]) {
            Err(SessionMapError::UnknownCoValue(id)) => assert_eq!(id, "co_zNope"),
            other => panic!("expected UnknownCoValue, got {other:?}"),
        }

        match node.role_of("co_zNope", "co_zX", None) {
            Err(SessionMapError::UnknownCoValue(id)) => assert_eq!(id, "co_zNope"),
            other => panic!("expected UnknownCoValue, got {other:?}"),
        }
    }

    /// A missing DEPENDENCY discovered while recursively building the primary
    /// coId's engine (here: the parent group referenced by a
    /// `parent_<id>` extension) must still surface as `CoValueNotLoaded`, not
    /// `UnknownCoValue` — only the primary coId gets the API-misuse treatment.
    #[test]
    fn missing_parent_dependency_is_covalue_not_loaded() {
        use crate::core::session_map::SessionMapError;

        let fix = FixtureFile::load("parent_extend");

        // The child references `parent_co_zcsomTZP9rEDbhYyqGzHvb1vC24` in its
        // transactions; find it (and its parent id) generically off the
        // fixture rather than hardcoding which covalue is "first".
        let child = fix
            .covalues
            .iter()
            .find(|cov| {
                cov.sessions.iter().any(|s| {
                    s.transactions
                        .iter()
                        .any(|raw| raw.contains("\\\"key\\\":\\\"parent_"))
                })
            })
            .expect("[parent_extend] fixture should contain a child with a parent_ extension");

        let parent_id = child
            .sessions
            .iter()
            .find_map(|s| {
                s.transactions.iter().find_map(|raw| {
                    let v: serde_json::Value = serde_json::from_str(raw).ok()?;
                    let changes_str = v.get("changes")?.as_str()?;
                    let changes: serde_json::Value = serde_json::from_str(changes_str).ok()?;
                    let key = changes.get(0)?.get("key")?.as_str()?;
                    key.strip_prefix("parent_").map(|id| id.to_string())
                })
            })
            .expect("[parent_extend] child should have a parent_<id> extension key");

        // Load ONLY the child covalue — the parent is never registered.
        let mut node = NodeCore::new();
        let _ = build_session_map(child); // sanity: header + txs parse under skip_verify
        node.create_co_value(&child.co_id, &child.header_json, None, true)
            .unwrap_or_else(|e| panic!("[parent_extend] create {}: {e}", child.co_id));
        for session in &child.sessions {
            let txs_json = format!("[{}]", session.transactions.join(","));
            node.get_mut(&child.co_id)
                .unwrap()
                .add_transactions(
                    &session.session_id,
                    None,
                    &txs_json,
                    &session.last_signature,
                    true,
                )
                .unwrap_or_else(|e| panic!("[parent_extend] add txs {}: {e}", session.session_id));
        }

        match node.validate_transactions(&child.co_id, &[]) {
            Err(SessionMapError::CoValueNotLoaded(id)) => assert_eq!(id, parent_id),
            other => panic!("expected CoValueNotLoaded({parent_id}), got {other:?}"),
        }
    }

    // =====================================================================
    // Safe incremental validation: fast-path == full recompute
    // =====================================================================

    use super::EXTEND_COUNT;
    use std::collections::BTreeMap;
    use std::sync::atomic::Ordering;

    /// A verdict keyed for order-independent comparison: two engines that
    /// validate the same total history must agree on every `(session, tx)`'s
    /// validity / outcome / reason, regardless of the order equal-time or
    /// independent (ownedByGroup) verdicts happen to be listed in.
    fn verdict_map(
        verdicts: &[Verdict],
    ) -> BTreeMap<(String, u32), (bool, String, Option<String>)> {
        verdicts
            .iter()
            .map(|v| {
                (
                    (v.session_id.clone(), v.tx_index),
                    (v.valid, v.outcome.as_str().to_string(), v.reason.clone()),
                )
            })
            .collect()
    }

    /// Tiny deterministic LCG so the property test is seeded and reproducible.
    struct Lcg(u64);
    impl Lcg {
        fn next(&mut self) -> u64 {
            self.0 = self
                .0
                .wrapping_mul(6364136223846793005)
                .wrapping_add(1442695040888963407);
            self.0 >> 16
        }
        fn below(&mut self, n: u64) -> u64 {
            self.next() % n
        }
    }

    const GROUP_ADMIN: &str = "co_zAdminAccountForIncrementalTests";
    const GROUP_SESSION: &str = "co_zAdminAccountForIncrementalTests_session_zPropTest";
    const GROUP_MEMBERS: [&str; 5] = ["co_zM0", "co_zM1", "co_zM2", "co_zM3", "co_zM4"];
    const GROUP_ROLES: [&str; 5] = ["reader", "writer", "manager", "admin", "revoked"];

    /// Build a group covalue header whose `initialAdmin` is [`GROUP_ADMIN`].
    fn prop_group_header() -> (String, String) {
        use crate::core::{CoValueHeader, NullableString, RulesetDef, Uniqueness};
        let header = CoValueHeader {
            created_at: NullableString::Missing,
            meta: None,
            ruleset: RulesetDef::group(GROUP_ADMIN),
            co_type: "comap".to_string(),
            uniqueness: Uniqueness::String("propgroup".to_string()),
        };
        let header_json = serde_json::to_string(&header).unwrap();
        (GROUP_ADMIN.to_string(), header_json)
    }

    /// One synthetic group transaction JSON (trusting `set` of a member role) at
    /// `made_at`.
    fn group_set_tx(key: &str, role: &str, made_at: u64) -> String {
        let changes =
            serde_json::to_string(&serde_json::json!([{"op":"set","key":key,"value":role}]))
                .unwrap();
        format!(
            r#"{{"privacy":"trusting","madeAt":{made_at},"changes":{}}}"#,
            serde_json::to_string(&changes).unwrap()
        )
    }

    /// Generate a random single-session group history for `seed`. tx0 is the
    /// admin self-promotion; the rest are random member→role sets by the admin.
    /// `out_of_order_pct` of the txs get an EARLIER madeAt (clock-skew arrivals)
    /// so both the strict-suffix extend path AND its fall-back are exercised.
    fn gen_group_history(seed: u64, count: usize, out_of_order_pct: u64) -> Vec<String> {
        let mut rng = Lcg(seed.wrapping_mul(0x9E3779B97F4A7C15).wrapping_add(1));
        let base = 1_700_000_000_000u64;
        let mut txs = vec![group_set_tx(GROUP_ADMIN, "admin", base)];
        let mut clock = base + 1000;
        for _ in 1..count {
            clock += 1 + rng.below(50);
            let made_at = if rng.below(100) < out_of_order_pct {
                // an earlier arrival that can reorder into history
                base + rng.below(clock - base)
            } else {
                clock
            };
            let member = GROUP_MEMBERS[rng.below(GROUP_MEMBERS.len() as u64) as usize];
            let role = GROUP_ROLES[rng.below(GROUP_ROLES.len() as u64) as usize];
            txs.push(group_set_tx(member, role, made_at));
        }
        txs
    }

    /// Load a whole history in ONE batch (pure full recompute).
    fn load_group_full(header_json: &str, txs: &[String]) -> NodeCore {
        let mut node = NodeCore::new();
        node.create_co_value(GROUP_ADMIN, header_json, None, true)
            .unwrap();
        let batch = format!("[{}]", txs.join(","));
        node.get_mut(GROUP_ADMIN)
            .unwrap()
            .add_transactions(GROUP_SESSION, None, &batch, "sig_zFake", true)
            .unwrap();
        node.validate_transactions(GROUP_ADMIN, &[]).unwrap();
        node
    }

    /// Load a history ONE TX AT A TIME, validating between each append so the
    /// incremental fast-path drives (extend on monotonic arrivals, fall back on
    /// out-of-order ones).
    fn load_group_incremental(header_json: &str, txs: &[String]) -> NodeCore {
        let mut node = NodeCore::new();
        node.create_co_value(GROUP_ADMIN, header_json, None, true)
            .unwrap();
        for tx in txs {
            let one = format!("[{tx}]");
            node.get_mut(GROUP_ADMIN)
                .unwrap()
                .add_transactions(GROUP_SESSION, None, &one, "sig_zFake", true)
                .unwrap();
            node.validate_transactions(GROUP_ADMIN, &[]).unwrap();
        }
        node
    }

    /// (i) The core guarantee: a suffix append EXTENDS and matches a
    /// from-scratch recompute verdict-for-verdict, across 50 seeded randomized
    /// group histories that mix in-order (extend) and out-of-order (fall-back)
    /// arrivals. `EXTEND_COUNT` proves the fast-path actually fired.
    #[test]
    fn incremental_matches_recompute_over_50_seeded_group_histories() {
        let (_, header_json) = prop_group_header();
        EXTEND_COUNT.store(0, Ordering::Relaxed);

        for seed in 0..50u64 {
            let txs = gen_group_history(seed, 40, 20);
            let mut full = load_group_full(&header_json, &txs);
            let mut incr = load_group_incremental(&header_json, &txs);

            let vf = verdict_map(&full.validate_transactions(GROUP_ADMIN, &[]).unwrap());
            let vi = verdict_map(&incr.validate_transactions(GROUP_ADMIN, &[]).unwrap());
            assert_eq!(
                vf, vi,
                "seed {seed}: incremental verdicts != full recompute"
            );

            // Roles must also agree at latest + a few sampled times.
            for member in GROUP_MEMBERS.iter().chain([&GROUP_ADMIN, &"everyone"]) {
                for at in [None, Some(1_700_000_000_500u64), Some(1_700_000_002_000u64)] {
                    let rf = full.role_of(GROUP_ADMIN, member, at).unwrap();
                    let ri = incr.role_of(GROUP_ADMIN, member, at).unwrap();
                    assert_eq!(rf, ri, "seed {seed}: role({member},{at:?}) mismatch");
                }
            }
        }

        assert!(
            EXTEND_COUNT.load(Ordering::Relaxed) > 0,
            "the incremental fast-path must have fired at least once"
        );
    }

    /// S3 write-bench guard: the keys-version stamp must NOT reintroduce a
    /// per-step FULL RECOMPUTE in the common no-key-change case — every monotonic
    /// ingest must still take the EXTEND fast-path. The keys-version comparison is
    /// O(1), so it cannot change the write path's complexity; this bench reports
    /// the end-to-end per-ingest cost and pins the fast-path against a control
    /// that DOES full-recompute every step (a fresh key before each validate). The
    /// no-key-change run must be materially cheaper than the recompute-every-step
    /// control; a keys-version regression that recomputed on every ingest would
    /// erase that gap. Prints both numbers (`--nocapture`).
    ///
    /// (Both curves carry the pre-existing O(n) suffix-collection scan in
    /// `collect_group_txs_after`, unaffected by this change, so the 2N/N wall
    /// ratio is ~3–4 for either; the FAST-vs-RECOMPUTE gap is the load-bearing
    /// signal here, not the ratio.)
    #[test]
    fn s3_write_path_stays_on_fast_path_without_key_changes() {
        let (_, header_json) = prop_group_header();

        let ingest = |n: usize, rekey_each_step: bool| -> std::time::Duration {
            let txs = gen_group_history(1234, n, 0); // 0% out-of-order → all extend
            let mut node = NodeCore::new();
            node.create_co_value(GROUP_ADMIN, &header_json, None, true)
                .unwrap();
            let start = std::time::Instant::now();
            for (i, tx) in txs.iter().enumerate() {
                node.get_mut(GROUP_ADMIN)
                    .unwrap()
                    .add_transactions(GROUP_SESSION, None, &format!("[{tx}]"), "sig_zFake", true)
                    .unwrap();
                if rekey_each_step {
                    // Control: bump the keys-version every step → forces the
                    // keys-version guard to full-recompute on each ingest.
                    node.provide_key_secret(&format!("key_zControl{i}"), &test_key_secret(1));
                }
                node.validate_transactions(GROUP_ADMIN, &[]).unwrap();
            }
            start.elapsed()
        };

        let _ = ingest(200, false); // warm up
        let n = 1500usize;
        let fast = ingest(n, false);
        let recompute = ingest(n, true);
        println!(
            "S3 write-bench @ {n} txs: no-key-change (fast-path) = {:.2}ms, rekey-every-step (full-recompute control) = {:.2}ms, speedup = {:.2}x",
            fast.as_secs_f64() * 1e3,
            recompute.as_secs_f64() * 1e3,
            recompute.as_secs_f64() / fast.as_secs_f64().max(1e-9),
        );
        assert!(
            fast < recompute,
            "the no-key-change path must stay on the extend fast-path (cheaper than recompute-every-step); \
             fast={fast:?} recompute={recompute:?}"
        );
    }

    /// A purely monotonic history extends on EVERY step — a strong lower bound on
    /// how often the fast-path runs (proves it is not silently always falling
    /// back), and still matches full recompute.
    #[test]
    fn monotonic_history_extends_every_step_and_matches() {
        let (_, header_json) = prop_group_header();
        let txs = gen_group_history(999, 30, 0); // 0% out-of-order
        EXTEND_COUNT.store(0, Ordering::Relaxed);
        let mut full = load_group_full(&header_json, &txs);
        let mut incr = load_group_incremental(&header_json, &txs);
        assert_eq!(
            verdict_map(&full.validate_transactions(GROUP_ADMIN, &[]).unwrap()),
            verdict_map(&incr.validate_transactions(GROUP_ADMIN, &[]).unwrap()),
        );
        // 30 txs loaded one-at-a-time, all monotonic after tx0 → ~29 extends.
        assert!(
            EXTEND_COUNT.load(Ordering::Relaxed) >= 20,
            "monotonic incremental load must extend on nearly every step, got {}",
            EXTEND_COUNT.load(Ordering::Relaxed)
        );
    }

    /// The delta API contract, driven by a simulated TS cursor over a mixed
    /// (in-order + out-of-order) incremental load:
    ///   • an EXTEND returns only the appended tail (`from_index == cursor`), and
    ///     the untouched prefix is never re-sent;
    ///   • a RECOMPUTE (generation bump from an out-of-order flip) returns the
    ///     FULL list (`from_index == 0`) so the cursor resets and flips reach old
    ///     txs;
    ///   • reconstructing the verdict list delta-by-delta EXACTLY as TS does
    ///     equals the authoritative full `validate_transactions` at every step.
    /// Both branches must actually fire.
    #[test]
    fn delta_cursor_reconstructs_full_validate_over_mixed_history() {
        let (_, header_json) = prop_group_header();
        let txs = gen_group_history(7, 40, 25); // 25% out-of-order → forces flips

        let mut node = NodeCore::new();
        node.create_co_value(GROUP_ADMIN, &header_json, None, true)
            .unwrap();

        let mut cur_gen: u64 = 0;
        let mut cur_count: u32 = 0;
        let mut reconstructed: Vec<Verdict> = Vec::new();
        let mut extends = 0u32;
        let mut recomputes = 0u32;

        for tx in &txs {
            let one = format!("[{tx}]");
            node.get_mut(GROUP_ADMIN)
                .unwrap()
                .add_transactions(GROUP_SESSION, None, &one, "sig_zFake", true)
                .unwrap();

            let delta = node
                .validate_transactions_delta(GROUP_ADMIN, cur_gen, cur_count, &[])
                .unwrap();
            if delta.from_index == 0 {
                recomputes += 1;
                reconstructed = delta.verdicts.clone();
            } else {
                extends += 1;
                assert_eq!(
                    delta.from_index as usize,
                    reconstructed.len(),
                    "an extend delta must begin exactly at the cursor position"
                );
                reconstructed.extend(delta.verdicts.iter().cloned());
            }
            cur_gen = delta.generation;
            cur_count = reconstructed.len() as u32;

            let full = node.validate_transactions(GROUP_ADMIN, &[]).unwrap();
            assert_eq!(
                reconstructed, full,
                "delta-reconstructed verdicts diverged from full validate"
            );
        }

        assert!(extends > 0, "no extend delta ever fired");
        assert!(
            recomputes > 1,
            "expected out-of-order flips to force >1 full-recompute delta, got {recomputes}"
        );
    }

    // =====================================================================
    // F6: adversarial property generator — multiple sessions, private txs with
    // keys provided mid/late, merge meta (tamper + benign), fww, unsafeAllowAll,
    // ownedByGroup over a mutating group. Invariant: incremental == full
    // recompute, verdict-for-verdict + role-for-role + coMap snapshot equality.
    // =====================================================================

    /// One generated transaction to append to a covalue, in load order.
    #[derive(Clone)]
    enum GenTx {
        /// A trusting `set` on `session`, optionally carrying wire meta (fww /
        /// merge `{mi,t}`) as a stringified JSON object.
        Trusting {
            session: usize,
            key: String,
            val: u64,
            made_at: u64,
            meta: Option<String>,
        },
        /// A private `set` on `session`, encrypted under the single test key,
        /// optionally carrying (encrypted) meta.
        Private {
            session: usize,
            key: String,
            val: u64,
            made_at: u64,
            meta: Option<String>,
        },
    }

    const UAA_SESSIONS: [&str; 3] = [
        "co_zUAAuthor_session_zPropA",
        "co_zUAAuthor_session_zPropB",
        "co_zUAAuthor_session_zPropC",
    ];
    const UAA_KEY_ID: &str = "key_zPropMixed";

    fn set_changes(key: &str, val: u64) -> String {
        serde_json::to_string(&serde_json::json!([{"op":"set","key":key,"value":val}])).unwrap()
    }

    /// Wire JSON for a trusting tx (both `changes` and `meta` are stringified
    /// JSON, matching the on-wire encoding).
    fn trusting_wire(changes: &str, made_at: u64, meta_obj: Option<&str>) -> String {
        let changes_field = serde_json::to_string(changes).unwrap();
        match meta_obj {
            Some(m) => {
                let meta_field = serde_json::to_string(m).unwrap();
                format!(
                    r#"{{"privacy":"trusting","madeAt":{made_at},"changes":{changes_field},"meta":{meta_field}}}"#
                )
            }
            None => {
                format!(r#"{{"privacy":"trusting","madeAt":{made_at},"changes":{changes_field}}}"#)
            }
        }
    }

    /// Generate a mixed unsafeAllowAll history for `seed`: multiple sessions,
    /// trusting + private txs, benign and back-dated (tamper) merge meta, and fww
    /// competitions — every adversarial channel a suffix extend must respect.
    fn gen_mixed_uaa_history(seed: u64, count: usize) -> Vec<GenTx> {
        let mut rng = Lcg(seed.wrapping_mul(0x2545F4914F6CDD1D).wrapping_add(7));
        let base = 1_700_000_000_000u64;
        let mut clock = base;
        let mut out = Vec::new();
        for i in 0..count {
            clock += 1 + rng.below(40);
            // ~15% arrive out-of-order (earlier), forcing extend fall-backs.
            let made_at = if rng.below(100) < 15 {
                base + rng.below((clock - base).max(1))
            } else {
                clock
            };
            let session = rng.below(UAA_SESSIONS.len() as u64) as usize;
            let key = format!("k{}", rng.below(6));
            let val = rng.below(1000);
            // Choose a meta channel.
            let meta = match rng.below(100) {
                0..=14 => {
                    Some(serde_json::json!({"fww": format!("lock{}", rng.below(3))}).to_string())
                }
                15..=24 => {
                    // benign merge: positive t → source earlier, never tamper.
                    Some(
                        serde_json::json!({"mi": i, "t": (1 + rng.below(5000)) as i64}).to_string(),
                    )
                }
                25..=31 => {
                    // tamper merge: negative t → source after current → invalid.
                    Some(
                        serde_json::json!({"mi": i, "t": -((1 + rng.below(5000)) as i64)})
                            .to_string(),
                    )
                }
                _ => None,
            };
            // ~35% private (encrypted under the single test key).
            if rng.below(100) < 35 {
                out.push(GenTx::Private {
                    session,
                    key,
                    val,
                    made_at,
                    meta,
                });
            } else {
                out.push(GenTx::Trusting {
                    session,
                    key,
                    val,
                    made_at,
                    meta,
                });
            }
        }
        out
    }

    /// Append one generated tx to `node`'s covalue `co_id`.
    fn apply_gen_tx(node: &mut NodeCore, co_id: &str, tx: &GenTx, secret: &str) {
        use crate::core::keys::SignerSecret;
        use ed25519_dalek::SigningKey;
        match tx {
            GenTx::Trusting {
                session,
                key,
                val,
                made_at,
                meta,
            } => {
                let changes = set_changes(key, *val);
                let wire = trusting_wire(&changes, *made_at, meta.as_deref());
                node.get_mut(co_id)
                    .unwrap()
                    .add_transactions(
                        UAA_SESSIONS[*session],
                        None,
                        &format!("[{wire}]"),
                        "sig",
                        true,
                    )
                    .unwrap();
            }
            GenTx::Private {
                session,
                key,
                val,
                made_at,
                meta,
            } => {
                let changes = set_changes(key, *val);
                let priv_signer = SignerSecret::from(SigningKey::from_bytes(&[7u8; 32])).0;
                node.get_mut(co_id)
                    .unwrap()
                    .make_new_private_transaction(
                        UAA_SESSIONS[*session].to_string(),
                        priv_signer,
                        &changes,
                        UAA_KEY_ID.to_string(),
                        secret.to_string(),
                        meta.clone(),
                        *made_at,
                    )
                    .unwrap();
            }
        }
    }

    fn new_uaa_node() -> (NodeCore, String) {
        use crate::core::{CoValueHeader, NullableString, RulesetDef, Uniqueness};
        let header = CoValueHeader {
            created_at: NullableString::Missing,
            meta: None,
            ruleset: RulesetDef::unsafe_allow_all(),
            co_type: "comap".to_string(),
            uniqueness: Uniqueness::String("propmixed".to_string()),
        };
        let header_json = serde_json::to_string(&header).unwrap();
        let co_id = crate::hash::blake3::short_hash_with_prefix(header_json.as_bytes(), "co_z");
        let mut node = NodeCore::new();
        node.create_co_value(&co_id, &header_json, None, true)
            .unwrap();
        (node, co_id)
    }

    /// F6 core: over 200 seeded mixed unsafeAllowAll histories (multi-session,
    /// private txs, benign + tamper merge meta, fww), an INCREMENTAL replay —
    /// validating and materializing between each append, with the private key
    /// provided at a per-seed MID or LATE point — must land on exactly the FULL
    /// recompute's verdicts AND coMap snapshot. Exercises every reviewer channel:
    /// key-arrival mid-history (F1), source timing without identity (F2), the
    /// unsafeAllowAll isolated-suffix sort (F4), and cross-session ties.
    #[test]
    fn incremental_matches_recompute_mixed_uaa_200_seeds() {
        let secret = test_key_secret(59);
        // NB: `EXTEND_COUNT` is a process-global shared with the dedicated
        // fast-path-fires tests; those own the "did it extend" assertion. This
        // test owns CORRECTNESS (incremental == full) and deliberately does not
        // touch the counter, so the two never race.
        for seed in 0..200u64 {
            let history = gen_mixed_uaa_history(seed, 24);

            // --- Full reference: append all, provide key, validate+materialize. ---
            let (mut full, co_id) = new_uaa_node();
            for tx in &history {
                apply_gen_tx(&mut full, &co_id, tx, &secret);
            }
            full.provide_key_secret(UAA_KEY_ID, &secret);
            let vf = verdict_map(&full.validate_transactions(&co_id, &[]).unwrap());
            full.map_materialize(&co_id, &[]).unwrap();
            let sf: serde_json::Value =
                serde_json::from_str(&full.map_snapshot(&co_id).unwrap()).unwrap();

            // --- Incremental: append one at a time, validate+materialize between,
            // provide the key at a per-seed step (mid for even seeds, late for odd). ---
            let (mut incr, _) = new_uaa_node();
            let provide_at = if seed % 2 == 0 {
                history.len() / 2
            } else {
                history.len()
            };
            for (i, tx) in history.iter().enumerate() {
                if i == provide_at {
                    incr.provide_key_secret(UAA_KEY_ID, &secret);
                }
                apply_gen_tx(&mut incr, &co_id, tx, &secret);
                incr.validate_transactions(&co_id, &[]).unwrap();
                incr.map_materialize(&co_id, &[]).unwrap();
            }
            if provide_at >= history.len() {
                incr.provide_key_secret(UAA_KEY_ID, &secret);
            }
            let vi = verdict_map(&incr.validate_transactions(&co_id, &[]).unwrap());
            incr.map_materialize(&co_id, &[]).unwrap();
            let si: serde_json::Value =
                serde_json::from_str(&incr.map_snapshot(&co_id).unwrap()).unwrap();

            assert_eq!(
                vf, vi,
                "seed {seed}: verdicts diverge (incremental != full)"
            );
            assert_eq!(
                sf, si,
                "seed {seed}: coMap snapshot diverges (incremental != full)"
            );
        }
    }

    /// F6 (group): 200 seeded MULTI-SESSION group histories — the admin session
    /// plus member sessions granting/using roles with out-of-order arrivals —
    /// must match full recompute verdict-for-verdict AND role-for-role. The
    /// single-session generator could never produce cross-session watermark ties.
    #[test]
    fn incremental_matches_recompute_multi_session_group_200_seeds() {
        let (_, header_json) = prop_group_header();
        // See the note on the mixed-uaa test: correctness only, no EXTEND_COUNT.
        for seed in 0..200u64 {
            let mut rng = Lcg(seed.wrapping_mul(0x9E3779B97F4A7C15).wrapping_add(3));
            let base = 1_700_000_000_000u64;
            // Sessions 1..=2 belong to members the admin promotes to admin so
            // their own grants can validate.
            let member_sessions = [
                ("co_zM0", "co_zM0_session_zMS0"),
                ("co_zM1", "co_zM1_session_zMS1"),
            ];
            let mut load: Vec<(String, String)> = Vec::new();
            load.push((
                GROUP_SESSION.to_string(),
                group_set_tx(GROUP_ADMIN, "admin", base),
            ));
            let mut clock = base + 10;
            for (m, _s) in &member_sessions {
                clock += 5;
                load.push((GROUP_SESSION.to_string(), group_set_tx(m, "admin", clock)));
            }
            for _ in 0..24 {
                clock += 1 + rng.below(40);
                let made_at = if rng.below(100) < 20 {
                    base + rng.below((clock - base).max(1))
                } else {
                    clock
                };
                let from_member = rng.below(3) != 0;
                let session = if from_member {
                    member_sessions[rng.below(2) as usize].1.to_string()
                } else {
                    GROUP_SESSION.to_string()
                };
                let target = GROUP_MEMBERS[rng.below(GROUP_MEMBERS.len() as u64) as usize];
                let role = GROUP_ROLES[rng.below(GROUP_ROLES.len() as u64) as usize];
                load.push((session, group_set_tx(target, role, made_at)));
            }

            // Full: batch per session (first-appearance session order).
            let mut full = NodeCore::new();
            full.create_co_value(GROUP_ADMIN, &header_json, None, true)
                .unwrap();
            let mut per_session: Vec<(String, Vec<String>)> = Vec::new();
            for (s, tx) in &load {
                match per_session.iter_mut().find(|(id, _)| id == s) {
                    Some((_, v)) => v.push(tx.clone()),
                    None => per_session.push((s.clone(), vec![tx.clone()])),
                }
            }
            for (s, txs) in &per_session {
                full.get_mut(GROUP_ADMIN)
                    .unwrap()
                    .add_transactions(s, None, &format!("[{}]", txs.join(",")), "sig", true)
                    .unwrap();
            }
            let vf = verdict_map(&full.validate_transactions(GROUP_ADMIN, &[]).unwrap());

            // Incremental: append one tx at a time in load order, validate between.
            let mut incr = NodeCore::new();
            incr.create_co_value(GROUP_ADMIN, &header_json, None, true)
                .unwrap();
            for (s, tx) in &load {
                incr.get_mut(GROUP_ADMIN)
                    .unwrap()
                    .add_transactions(s, None, &format!("[{tx}]"), "sig", true)
                    .unwrap();
                incr.validate_transactions(GROUP_ADMIN, &[]).unwrap();
            }
            let vi = verdict_map(&incr.validate_transactions(GROUP_ADMIN, &[]).unwrap());
            assert_eq!(vf, vi, "seed {seed}: multi-session group verdicts diverge");

            for member in GROUP_MEMBERS.iter().chain([&GROUP_ADMIN, &"everyone"]) {
                for at in [None, Some(base + 20), Some(base + 500), Some(base + 2000)] {
                    let rf = full.role_of(GROUP_ADMIN, member, at).unwrap();
                    let ri = incr.role_of(GROUP_ADMIN, member, at).unwrap();
                    assert_eq!(rf, ri, "seed {seed}: role({member},{at:?}) diverges");
                }
            }
        }
    }

    /// F2 (SUSPICIOUS) targeted: a pending `source_made_at` WITHOUT a
    /// `source_tx_id` (no merge identity, `is_merge` false) is a bare re-timing
    /// channel. The tightened S2 must treat it as re-identifying and FALL BACK to
    /// a full recompute rather than blind-extend. Pinned behaviorally: the
    /// incremental result equals a full recompute even when such a tx is appended.
    #[test]
    fn f2_pending_source_timing_without_identity_forces_fallback() {
        use crate::core::group_engine::tx_view::PendingTxIn;
        use crate::core::{CoValueHeader, NullableString, RulesetDef, Uniqueness};

        let header = CoValueHeader {
            created_at: NullableString::Missing,
            meta: None,
            ruleset: RulesetDef::unsafe_allow_all(),
            co_type: "comap".to_string(),
            uniqueness: Uniqueness::String("f2timing".to_string()),
        };
        let header_json = serde_json::to_string(&header).unwrap();
        let co_id = crate::hash::blake3::short_hash_with_prefix(header_json.as_bytes(), "co_z");
        let base = 1_700_000_000_000u64;
        let session = "co_zF2_session_zA";
        let tx0 = trusting_wire(&set_changes("a", 1), base + 100, None);
        let tx1 = trusting_wire(&set_changes("b", 2), base + 50, None);
        let pending = vec![PendingTxIn {
            session_id: session.to_string(),
            tx_index: 1,
            source_made_at: Some(base + 5000),
            meta_json: None,
            source_tx_id: None,
        }];

        let mut full = NodeCore::new();
        full.create_co_value(&co_id, &header_json, None, true)
            .unwrap();
        full.get_mut(&co_id)
            .unwrap()
            .add_transactions(session, None, &format!("[{tx0},{tx1}]"), "sig", true)
            .unwrap();
        let vf = verdict_map(&full.validate_transactions(&co_id, &pending).unwrap());

        let mut incr = NodeCore::new();
        incr.create_co_value(&co_id, &header_json, None, true)
            .unwrap();
        incr.get_mut(&co_id)
            .unwrap()
            .add_transactions(session, None, &format!("[{tx0}]"), "sig", true)
            .unwrap();
        incr.validate_transactions(&co_id, &pending).unwrap();
        incr.get_mut(&co_id)
            .unwrap()
            .add_transactions(session, None, &format!("[{tx1}]"), "sig", true)
            .unwrap();
        let vi = verdict_map(&incr.validate_transactions(&co_id, &pending).unwrap());

        assert_eq!(
            vf, vi,
            "source-timed suffix must not corrupt via a blind extend"
        );
    }

    /// F5 (SUSPICIOUS) targeted: an ownedByGroup covalue whose OWNING GROUP gains
    /// transactions (a member promoted) between owned ingests. Owned txs by that
    /// member, appended before and after the promotion, must match full recompute
    /// — the S4 group-change guard (counts + generation) forces a fall-back when
    /// the group moved.
    #[test]
    fn f5_owned_over_mutating_group_matches_recompute() {
        use crate::core::{CoValueHeader, NullableString, RulesetDef, Uniqueness};

        const ADMIN: &str = "co_zF5Admin";
        const GROUP_SESS: &str = "co_zF5Admin_session_zG";
        let member = "co_zF5Member";
        let member_owned_session = "co_zF5Member_session_zO";
        let base = 1_700_000_000_000u64;

        let group_header = CoValueHeader {
            created_at: NullableString::Missing,
            meta: None,
            ruleset: RulesetDef::group(ADMIN),
            co_type: "comap".to_string(),
            uniqueness: Uniqueness::String("f5group".to_string()),
        };
        let group_header_json = serde_json::to_string(&group_header).unwrap();

        let owned_header = CoValueHeader {
            created_at: NullableString::Missing,
            meta: None,
            ruleset: RulesetDef::owned_by_group(ADMIN),
            co_type: "comap".to_string(),
            uniqueness: Uniqueness::String("f5owned".to_string()),
        };
        let owned_header_json = serde_json::to_string(&owned_header).unwrap();
        let owned_id =
            crate::hash::blake3::short_hash_with_prefix(owned_header_json.as_bytes(), "co_z");

        let owned_tx = |made: u64| {
            let changes =
                serde_json::to_string(&serde_json::json!([{"op":"set","key":"x","value":made}]))
                    .unwrap();
            trusting_wire(&changes, made, None)
        };

        let build = |incremental: bool| -> BTreeMap<(String, u32), (bool, String, Option<String>)> {
            let mut node = NodeCore::new();
            node.create_co_value(ADMIN, &group_header_json, None, true)
                .unwrap();
            node.create_co_value(&owned_id, &owned_header_json, None, true)
                .unwrap();
            node.get_mut(ADMIN)
                .unwrap()
                .add_transactions(
                    GROUP_SESS,
                    None,
                    &format!("[{}]", group_set_tx(ADMIN, "admin", base)),
                    "sig",
                    true,
                )
                .unwrap();
            // Owned tx #0 by member BEFORE promotion → no role → invalid.
            node.get_mut(&owned_id)
                .unwrap()
                .add_transactions(
                    member_owned_session,
                    None,
                    &format!("[{}]", owned_tx(base + 50)),
                    "sig",
                    true,
                )
                .unwrap();
            if incremental {
                node.validate_transactions(&owned_id, &[]).unwrap();
            }
            // Group moves: admin promotes member to writer.
            node.get_mut(ADMIN)
                .unwrap()
                .add_transactions(
                    GROUP_SESS,
                    None,
                    &format!("[{}]", group_set_tx(member, "writer", base + 100)),
                    "sig",
                    true,
                )
                .unwrap();
            if incremental {
                node.validate_transactions(&owned_id, &[]).unwrap();
            }
            // Owned tx #1 by member AFTER promotion → writer → valid.
            node.get_mut(&owned_id)
                .unwrap()
                .add_transactions(
                    member_owned_session,
                    None,
                    &format!("[{}]", owned_tx(base + 200)),
                    "sig",
                    true,
                )
                .unwrap();
            verdict_map(&node.validate_transactions(&owned_id, &[]).unwrap())
        };

        let vf = build(false);
        let vi = build(true);
        assert_eq!(
            vf, vi,
            "owned-over-mutating-group: incremental must match full recompute"
        );
    }

    /// (R2 native meta) A merge transaction back-dated to AFTER its own
    /// currentMadeAt (negative `meta.t`) is marked invalid natively with the
    /// verbatim TS reason — no TS `pending` required. Uses `unsafeAllowAll` so
    /// the ONLY thing that can invalidate the tx is the anti-tamper override.
    #[test]
    fn merge_source_after_current_marks_invalid_natively() {
        use crate::core::{CoValueHeader, NullableString, RulesetDef, Uniqueness};
        let header = CoValueHeader {
            created_at: NullableString::Missing,
            meta: None,
            ruleset: RulesetDef::unsafe_allow_all(),
            co_type: "comap".to_string(),
            uniqueness: Uniqueness::String("tampertest".to_string()),
        };
        let header_json = serde_json::to_string(&header).unwrap();
        let co_id = crate::hash::blake3::short_hash_with_prefix(header_json.as_bytes(), "co_z");
        let mut node = NodeCore::new();
        node.create_co_value(&co_id, &header_json, None, true)
            .unwrap();

        let changes =
            serde_json::to_string(&serde_json::json!([{"op":"set","key":"k","value":1}])).unwrap();
        // tx0: normal. tx1: merge tx with negative t → source after current.
        let good_meta =
            serde_json::json!({"mi": 0, "t": 1000, "s": "co_zSrc_session_zA"}).to_string();
        let tamper_meta = serde_json::json!({"mi": 1, "t": -50_000}).to_string();
        let mk = |made: u64, meta: &str| {
            format!(
                r#"{{"privacy":"trusting","madeAt":{made},"changes":{},"meta":{}}}"#,
                serde_json::to_string(&changes).unwrap(),
                serde_json::to_string(meta).unwrap()
            )
        };
        let batch = format!(
            "[{},{}]",
            mk(1_700_000_100_000, &good_meta),
            mk(1_700_000_200_000, &tamper_meta)
        );
        node.get_mut(&co_id)
            .unwrap()
            .add_transactions("co_zA_session_zT", None, &batch, "sig", true)
            .unwrap();

        let verdicts = node.validate_transactions(&co_id, &[]).unwrap();
        let tamper = verdicts
            .iter()
            .find(|v| v.tx_index == 1)
            .expect("tamper tx verdict present");
        assert!(!tamper.valid, "back-dated merge tx must be invalid");
        assert_eq!(
            tamper.reason.as_deref(),
            Some("Transaction sourceMadeAt is after the currentMadeAt"),
        );
        // The normal merge tx (positive t) stays valid.
        assert!(verdicts.iter().find(|v| v.tx_index == 0).unwrap().valid);
    }

    /// A 32-byte test KeySecret in the `keySecret_z<base58>` wire form the
    /// xsalsa20 key derivation expects (shared by the key-arrival regressions).
    fn test_key_secret(byte: u8) -> String {
        format!("keySecret_z{}", bs58::encode([byte; 32]).into_string())
    }

    /// F1 (BREAK) deterministic regression: a key that arrives BETWEEN two
    /// validate calls, in the SAME window as a new appended tx, must not let the
    /// suffix extend preserve an OLD private tx's stale verdict.
    ///
    /// Setup (unsafeAllowAll, so ONLY the anti-tamper override can invalidate):
    ///   P: a PRIVATE tx whose ENCRYPTED meta is a back-dated merge
    ///      `{"mi":1,"t":-50000}` → once decrypted, `sourceMadeAt > currentMadeAt`
    ///      → Invalid. The key for P is NOT provided yet, so at first validate P's
    ///      meta is opaque and P reads Valid.
    ///   provide_key_secret → the node's keys-version bumps.
    ///   R: a later trusting tx appended in a second session.
    /// On the buggy code the second validate saw counts change, ran the extend
    /// (blind to the keys-version), appended R, and PRESERVED P's stale Valid —
    /// diverging from a full recompute (which, with the key, marks P Invalid).
    /// The keys-version guard forces a full recompute instead, so P flips to
    /// Invalid, matching the reference.
    #[test]
    fn f1_key_arrival_with_append_forces_recompute_not_stale_extend() {
        use crate::core::keys::SignerSecret;
        use crate::core::{CoValueHeader, NullableString, RulesetDef, Uniqueness};
        use ed25519_dalek::SigningKey;
        use rand_core::OsRng;

        let key_id = "key_zF1Tamper";
        let secret = test_key_secret(41);
        let priv_session = "co_zF1_session_zPriv";
        let trust_session = "co_zF1_session_zTrust";
        let base = 1_700_000_000_000u64;
        let tamper_meta = serde_json::json!({"mi": 1, "t": -50_000}).to_string();

        let header = CoValueHeader {
            created_at: NullableString::Missing,
            meta: None,
            ruleset: RulesetDef::unsafe_allow_all(),
            co_type: "comap".to_string(),
            uniqueness: Uniqueness::String("f1keyarrival".to_string()),
        };
        let header_json = serde_json::to_string(&header).unwrap();
        let co_id = crate::hash::blake3::short_hash_with_prefix(header_json.as_bytes(), "co_z");

        let changes =
            serde_json::to_string(&serde_json::json!([{"op":"set","key":"k","value":1}])).unwrap();
        let signer = SignerSecret::from(SigningKey::generate(&mut OsRng)).0;
        let r_tx = format!(
            r#"[{{"privacy":"trusting","madeAt":{},"changes":{}}}]"#,
            base + 100_000,
            serde_json::to_string(&changes).unwrap()
        );

        // --- Reference: full recompute with the key present from the start. ---
        let mut full = NodeCore::new();
        full.create_co_value(&co_id, &header_json, None, true)
            .unwrap();
        full.get_mut(&co_id)
            .unwrap()
            .make_new_private_transaction(
                priv_session.to_string(),
                signer.clone(),
                &changes,
                key_id.to_string(),
                secret.clone(),
                Some(tamper_meta.clone()),
                base,
            )
            .unwrap();
        full.get_mut(&co_id)
            .unwrap()
            .add_transactions(trust_session, None, &r_tx, "sig", true)
            .unwrap();
        full.provide_key_secret(key_id, &secret);
        let vf = verdict_map(&full.validate_transactions(&co_id, &[]).unwrap());

        // --- Incremental: validate BEFORE the key, then key + append + validate. ---
        let mut incr = NodeCore::new();
        incr.create_co_value(&co_id, &header_json, None, true)
            .unwrap();
        incr.get_mut(&co_id)
            .unwrap()
            .make_new_private_transaction(
                priv_session.to_string(),
                signer.clone(),
                &changes,
                key_id.to_string(),
                secret.clone(),
                Some(tamper_meta.clone()),
                base,
            )
            .unwrap();
        // First validate WITHOUT the key: P's tamper meta is opaque → P reads Valid.
        let before = verdict_map(&incr.validate_transactions(&co_id, &[]).unwrap());
        assert!(
            before.get(&(priv_session.to_string(), 0)).unwrap().0,
            "with no key, P's meta is opaque and P reads valid"
        );
        // Key arrives (keys-version bumps), then a later tx is appended.
        incr.provide_key_secret(key_id, &secret);
        incr.get_mut(&co_id)
            .unwrap()
            .add_transactions(trust_session, None, &r_tx, "sig", true)
            .unwrap();
        let vi = verdict_map(&incr.validate_transactions(&co_id, &[]).unwrap());

        // The fix: incremental == full, and P is now Invalid (tamper caught).
        assert_eq!(
            vi, vf,
            "incremental must match full recompute after key arrival"
        );
        let p = vi
            .get(&(priv_session.to_string(), 0))
            .expect("P verdict present");
        assert!(
            !p.0,
            "P's back-dated merge must flip to invalid once its key is available: {p:?}"
        );
        assert_eq!(
            p.2.as_deref(),
            Some("Transaction sourceMadeAt is after the currentMadeAt"),
        );
    }

    /// (ii) Out-of-order REVOCATION flip (the `nativeGroupFlip` scenario): a
    /// member is granted `writer`, then later (in load order) a revocation of the
    /// GRANTOR arrives with an EARLIER effective madeAt — sorting BEFORE the
    /// grant. Because the grantor was revoked first in validation order, the
    /// grant must FLIP to invalid. The incremental path MUST fall back (the new
    /// tx is not a strict-time suffix) and land on exactly the full-recompute
    /// verdicts.
    #[test]
    fn out_of_order_revocation_flips_and_incremental_falls_back() {
        let (_, header_json) = prop_group_header();
        let base = 1_700_000_000_000u64;

        // Load order:
        //   0: admin self-promote                     @ base
        //   1: admin sets M0 -> manager               @ base+100
        //   2: M0 (manager) sets M1 -> writer         @ base+200   (M0 session)
        //   3: admin revokes M0                        @ base+150   (arrives LAST,
        //                                                but sorts BETWEEN 1 and 2)
        // A manager (not an admin) can be revoked by an admin, and can grant
        // writers. In validation (effective-madeAt) order the revocation lands
        // after the promotion but BEFORE M0's grant, so by the grant's time M0
        // has no role and its grant flips to invalid.
        let m0_session = "co_zM0_session_zFlip";
        let admin_txs = vec![
            group_set_tx(GROUP_ADMIN, "admin", base),
            group_set_tx("co_zM0", "manager", base + 100),
            group_set_tx("co_zM0", "revoked", base + 150),
        ];
        let m0_tx = group_set_tx("co_zM1", "writer", base + 200);

        // Full recompute reference.
        let mut full = NodeCore::new();
        full.create_co_value(GROUP_ADMIN, &header_json, None, true)
            .unwrap();
        full.get_mut(GROUP_ADMIN)
            .unwrap()
            .add_transactions(
                GROUP_SESSION,
                None,
                &format!("[{}]", admin_txs.join(",")),
                "sig_zFake",
                true,
            )
            .unwrap();
        full.get_mut(GROUP_ADMIN)
            .unwrap()
            .add_transactions(m0_session, None, &format!("[{m0_tx}]"), "sig_zFake", true)
            .unwrap();
        let vf = verdict_map(&full.validate_transactions(GROUP_ADMIN, &[]).unwrap());

        // Incremental: admin self-promote + M0->admin (monotonic, extends), then
        // M0's writer grant (extends), THEN the earlier-timed revocation arrives
        // — which must force a fall-back and flip M0's grant to invalid.
        EXTEND_COUNT.store(0, Ordering::Relaxed);
        let mut incr = NodeCore::new();
        incr.create_co_value(GROUP_ADMIN, &header_json, None, true)
            .unwrap();
        let add_admin = |n: &mut NodeCore, tx: &str| {
            n.get_mut(GROUP_ADMIN)
                .unwrap()
                .add_transactions(GROUP_SESSION, None, &format!("[{tx}]"), "sig_zFake", true)
                .unwrap();
            n.validate_transactions(GROUP_ADMIN, &[]).unwrap();
        };
        add_admin(&mut incr, &admin_txs[0]); // self-promote
        add_admin(&mut incr, &admin_txs[1]); // M0 -> admin
                                             // M0's writer grant in its own session.
        incr.get_mut(GROUP_ADMIN)
            .unwrap()
            .add_transactions(m0_session, None, &format!("[{m0_tx}]"), "sig_zFake", true)
            .unwrap();
        incr.validate_transactions(GROUP_ADMIN, &[]).unwrap();
        // The earlier-timed revocation — must reorder into the middle → fall back.
        add_admin(&mut incr, &admin_txs[2]);

        let vi = verdict_map(&incr.validate_transactions(GROUP_ADMIN, &[]).unwrap());
        assert_eq!(
            vf, vi,
            "incremental must match full recompute after the flip"
        );

        // Pin the actual flip: M0's writer grant on `co_zM1` is INVALID because
        // its author was revoked earlier in effective order.
        let grant = vi
            .get(&(m0_session.to_string(), 0))
            .expect("M0's grant verdict present");
        assert!(
            !grant.0,
            "the writer grant must have flipped to invalid (grantor revoked earlier): {grant:?}"
        );
    }

    /// Load a fixture covalue's transactions into `node` in ONE batch per
    /// session (the standalone helper's full-recompute shape).
    fn load_cov_full(
        node: &mut NodeCore,
        name: &str,
        cov: &crate::core::group_engine::tx_view::fixtures::FixtureCovalue,
    ) {
        for session in &cov.sessions {
            let txs_json = format!("[{}]", session.transactions.join(","));
            node.get_mut(&cov.co_id)
                .unwrap()
                .add_transactions(
                    &session.session_id,
                    None,
                    &txs_json,
                    &session.last_signature,
                    true,
                )
                .unwrap_or_else(|e| panic!("[{name}] add {}: {e}", session.session_id));
        }
    }

    /// The 25 golden fixtures must produce identical verdicts/roles whether a
    /// verdict covalue is validated after a single-batch full recompute or after
    /// an INCREMENTAL, one-transaction-at-a-time replay (validating between each
    /// append so the safe fast-path drives). To honour the cross-CoValue reset
    /// contract (a dependency loading later would, in TS, `resetValidation` its
    /// dependants), every OTHER covalue is loaded FULLY first, so the target's
    /// dependencies are already present while it is replayed incrementally.
    fn run_fixture_both_paths(name: &str) {
        let fix = FixtureFile::load(name);
        let mut full = load_fixture_node(name, &fix);

        for target in fix.verdicts.keys() {
            let mut incr = NodeCore::new();
            for cov in &fix.covalues {
                incr.create_co_value(&cov.co_id, &cov.header_json, None, true)
                    .unwrap_or_else(|e| panic!("[{name}] incr create {}: {e}", cov.co_id));
            }
            // Dependencies (every non-target covalue) fully loaded up front.
            for cov in &fix.covalues {
                if &cov.co_id != target {
                    load_cov_full(&mut incr, name, cov);
                }
            }
            // The target replayed one transaction at a time, validating between
            // — this is what actually drives the incremental extend path.
            let target_cov = fix
                .covalues
                .iter()
                .find(|c| &c.co_id == target)
                .expect("verdict covalue present among fixture covalues");
            for session in &target_cov.sessions {
                for tx in &session.transactions {
                    incr.get_mut(target)
                        .unwrap()
                        .add_transactions(
                            &session.session_id,
                            None,
                            &format!("[{tx}]"),
                            &session.last_signature,
                            true,
                        )
                        .unwrap_or_else(|e| {
                            panic!("[{name}] incr add {}: {e}", session.session_id)
                        });
                    incr.validate_transactions(target, &[]).unwrap();
                }
            }

            let vf = verdict_map(&full.validate_transactions(target, &[]).unwrap());
            let vi = verdict_map(&incr.validate_transactions(target, &[]).unwrap());
            assert_eq!(vf, vi, "[{name}] {target}: incremental verdicts != full");

            // Role queries scoped to this target group also match.
            for q in fix.role_queries.iter().filter(|q| &q.group_id == target) {
                let rf = full.role_of(&q.group_id, &q.member, q.at_time).unwrap();
                let ri = incr.role_of(&q.group_id, &q.member, q.at_time).unwrap();
                assert_eq!(
                    rf, ri,
                    "[{name}] role({}, {}, {:?}) mismatch",
                    q.group_id, q.member, q.at_time
                );
            }
        }
    }

    macro_rules! fixture_both_paths_test {
        ($fn_name:ident, $file:literal) => {
            #[test]
            fn $fn_name() {
                run_fixture_both_paths($file);
            }
        };
    }

    fixture_both_paths_test!(bp_account_agent_resolution, "account_agent_resolution");
    fixture_both_paths_test!(bp_admin_demotion_rules, "admin_demotion_rules");
    fixture_both_paths_test!(bp_all_invites, "all_invites");
    fixture_both_paths_test!(bp_basic_roles, "basic_roles");
    fixture_both_paths_test!(bp_cross_session_ties, "cross_session_ties");
    fixture_both_paths_test!(bp_deep_parent_chain, "deep_parent_chain");
    fixture_both_paths_test!(bp_everyone_roles, "everyone_roles");
    fixture_both_paths_test!(
        bp_initial_admin_self_promotion,
        "initial_admin_self_promotion"
    );
    fixture_both_paths_test!(bp_key_revelations, "key_revelations");
    fixture_both_paths_test!(bp_malformed_changes, "malformed_changes");
    fixture_both_paths_test!(bp_manager_rules, "manager_rules");
    fixture_both_paths_test!(bp_parent_capped, "parent_capped");
    fixture_both_paths_test!(bp_parent_extend, "parent_extend");
    fixture_both_paths_test!(bp_parent_revoked_inheritance, "parent_revoked_inheritance");
    fixture_both_paths_test!(bp_private_tx_in_group, "private_tx_in_group");
    fixture_both_paths_test!(bp_self_extension_cycle, "self_extension_cycle");
    fixture_both_paths_test!(bp_self_revoke, "self_revoke");
    fixture_both_paths_test!(bp_write_only_keys, "write_only_keys");
    fixture_both_paths_test!(bp_unsafe_allow_all, "unsafe_allow_all");
    fixture_both_paths_test!(bp_owned_by_account, "owned_by_account");
    fixture_both_paths_test!(bp_owned_by_group_roles, "owned_by_group_roles");
    fixture_both_paths_test!(
        bp_owned_by_group_role_change_over_time,
        "owned_by_group_role_change_over_time"
    );
    fixture_both_paths_test!(
        bp_owned_reader_branch_pointer,
        "owned_reader_branch_pointer"
    );
    fixture_both_paths_test!(
        bp_owned_private_tx_meta_unavailable,
        "owned_private_tx_meta_unavailable"
    );
    fixture_both_paths_test!(bp_merged_tx_ties, "merged_tx_ties");
}
