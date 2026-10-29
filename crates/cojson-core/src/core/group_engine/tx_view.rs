//! Group transaction views and validation ordering.
//!
//! Builds [`GroupTxView`]s from a [`SessionMapImpl`] — iterating sessions in
//! insertion order, transactions by index within a session, parsing each
//! transaction JSON exactly once — and sorts them with the validation
//! comparator ported from `coValueCore.ts:1842-1855` (`compareTransactions`).
//!
//! The comparator orders by `effective_made_at` ascending; ties are broken by
//! EFFECTIVE txIndex only within the same EFFECTIVE session (`txID =
//! sourceTxID ?? currentTxID`, `coValueCore.ts:157-159`: a merged transaction's
//! identity for tie-breaking is its SOURCE `(sessionID, txIndex)` when known,
//! falling back to its stored `(session_id, tx_index)` otherwise), and across
//! (effective) sessions the original (session-insertion) order is preserved:
//! Rust's `Vec::sort_by` is stable, so returning
//! [`Equal`](core::cmp::Ordering::Equal) for cross-session ties keeps the
//! iteration order established by [`collect_group_txs`]. The
//! `cross_session_ties` fixture exists precisely to pin this outcome.

use crate::core::group_engine::classify::author_from_session_id;
use crate::core::session_log::Transaction;
use crate::core::SessionMapImpl;
use std::collections::HashMap;

/// Wire shape of a merged transaction's source identity: `{"sessionID": ...,
/// "txIndex": ...}` — same field casing as `TransactionID`
/// (`session_log.rs`): `sessionID` with a capital ID, not camelCase `sessionId`.
#[derive(Debug, Clone, serde::Deserialize)]
struct SourceTxIdWire {
    #[serde(rename = "sessionID")]
    session_id: String,
    #[serde(rename = "txIndex")]
    tx_index: u32,
}

/// Deserializes the optional `sourceTxId: {"sessionID", "txIndex"}` wire
/// object into `Option<(String, u32)>`.
fn deserialize_source_tx_id<'de, D>(deserializer: D) -> Result<Option<(String, u32)>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    let wire: Option<SourceTxIdWire> = serde::Deserialize::deserialize(deserializer)?;
    Ok(wire.map(|w| (w.session_id, w.tx_index)))
}

/// Extra per-transaction info the sync/merge layer supplies (merge-meta
/// derived source times, decrypted meta, and merged-transaction source
/// identity). Looked up by `(session_id, tx_index)` inside
/// [`collect_group_txs`].
#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PendingTxIn {
    pub session_id: String,
    pub tx_index: u32,
    #[serde(default)]
    pub source_made_at: Option<u64>,
    /// Decrypted meta JSON for this pending tx (plaintext string; the sync/
    /// merge layer decrypts private-tx meta before this point). Takes
    /// precedence over the TRUSTING tx's own wire `meta` field when building
    /// [`GroupTxView::meta`].
    #[serde(default)]
    pub meta_json: Option<String>,
    /// Merged-transaction source identity: `(sourceTxId.sessionID,
    /// sourceTxId.txIndex)`. Wire shape: `{"sourceTxId": {"sessionID": ...,
    /// "txIndex": ...}}`.
    #[serde(default, deserialize_with = "deserialize_source_tx_id")]
    pub source_tx_id: Option<(String, u32)>,
}

/// Privacy class of a transaction, derived from the wire [`Transaction`] variant.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Privacy {
    Private,
    Trusting,
}

/// A flattened, parsed view of one group transaction, ready for the validation
/// pass. Built by [`collect_group_txs`].
#[derive(Debug, Clone)]
pub struct GroupTxView {
    pub session_id: String,
    pub tx_index: u32,
    /// `accountOrAgentIDfromSessionID(session_id)` — the transaction author.
    pub author: String,
    /// The transaction's own `madeAt` — used for permission checks.
    pub current_made_at: u64,
    /// `source_made_at.unwrap_or(current_made_at)` — the merge-meta-derived time
    /// used for ORDERING. Falls back to [`GroupTxView::current_made_at`] when no
    /// pending info is supplied for this transaction.
    pub effective_made_at: u64,
    pub privacy: Privacy,
    /// Parsed `changes` array for trusting transactions. `None` for private
    /// transactions (their changes are encrypted/opaque at this layer) and,
    /// defensively, for trusting transactions whose `changes` string is not a
    /// valid JSON array — valid cojson producers always stringify a real array,
    /// so the latter does not occur for stored state.
    pub changes: Option<Vec<serde_json::Value>>,
    /// Parsed meta, when available: the pending tx's decrypted
    /// [`PendingTxIn::meta_json`] takes precedence; otherwise, for a TRUSTING
    /// tx, its own plaintext wire `meta` field; otherwise `None` (private tx
    /// with no supplied pending meta — the meta is encrypted/opaque here).
    pub meta: Option<serde_json::Value>,
    /// Source session id of a merged transaction (`sourceTxId.sessionID`),
    /// when supplied by `pending_info`. `None` for a transaction that is not a
    /// merge result — its identity IS its stored `(session_id, tx_index)`.
    pub source_session_id: Option<String>,
    /// Source tx index of a merged transaction (`sourceTxId.txIndex`); always
    /// present together with [`GroupTxView::source_session_id`].
    pub source_tx_index: Option<u32>,
    /// `keyUsed` (a `KeyID`) of a PRIVATE transaction — the key whose secret is
    /// needed to decrypt its changes. `None` for trusting transactions (their
    /// changes are plaintext). Consumed by coMap materialization (R1) to resolve
    /// the secret from `NodeCore`'s key store; the permission engine ignores it.
    pub key_used: Option<String>,
    /// True iff this transaction's merge-derived source made-at is STRICTLY
    /// AFTER its own `current_made_at` — the anti-tamper condition of
    /// `parseMetaInformation` (`coValueCore.ts:1554-1565`). Set from a merge
    /// tx's `meta.t` (`sourceTxMadeAt = currentMadeAt - t`, so a NEGATIVE `t`
    /// back-dates a write to after an access revocation) or from a
    /// TS-supplied `pending.sourceMadeAt` that exceeds `currentMadeAt`. The
    /// engine turns this into the verbatim invalid verdict "Transaction
    /// sourceMadeAt is after the currentMadeAt".
    pub source_after_current: bool,
    /// True iff this transaction carries merge metadata (`meta.mi`) — a merged/
    /// branched transaction. The safe incremental fast-path treats any such tx
    /// among the newly-ingested set as a re-identification risk and falls back
    /// to a full recompute (it may re-time/re-order into history).
    pub is_merge: bool,
}

/// Parse one stored transaction JSON into a [`GroupTxView`], applying any
/// pending override for `(session_id, tx_index)`. Shared by
/// [`collect_group_txs`] and [`collect_group_txs_after`] so both paths build
/// byte-identical views. `keys` (when non-empty) lets a PRIVATE transaction's
/// meta be decrypted NATIVELY (R2, `parseMetaInformation`) via the key store,
/// so the permission engine no longer depends on TS supplying decrypted meta in
/// `pending`; pending meta still takes precedence when TS did supply it.
fn build_tx_view(
    sm: &SessionMapImpl,
    session_id: &str,
    tx_index: u32,
    tx_json: &str,
    pending: Option<&PendingTxIn>,
    keys: &HashMap<String, String>,
) -> GroupTxView {
    // SessionMapImpl stores only transactions it serialized itself, so every
    // entry re-parses as a Transaction; a failure here would indicate storage
    // corruption (and would silently change the validation set, so we surface
    // it loudly rather than skip).
    let tx: Transaction = serde_json::from_str(tx_json)
        .expect("stored transaction JSON must re-parse as Transaction");

    let (privacy, current_made_at, changes, trusting_meta, key_used) = match tx {
        Transaction::Trusting(t) => {
            // Cojson producers always stringify a valid JSON array; a parse
            // failure is defensive only (treated as no usable changes, which
            // downstream validation will reject).
            let changes = serde_json::from_str(&t.changes).ok();
            let made_at = t.made_at.as_u64().unwrap_or(0);
            (Privacy::Trusting, made_at, changes, t.meta, None)
        }
        Transaction::Private(p) => {
            let made_at = p.made_at.as_u64().unwrap_or(0);
            (Privacy::Private, made_at, None, None, Some(p.key_used.0))
        }
    };

    // Meta precedence (R2): pending's TS-decrypted meta wins; else, for a
    // PRIVATE tx, decrypt its meta NATIVELY when we hold the key (mirrors the
    // TS `decryptTransactionChangesAndMeta` step feeding `parseMetaInformation`);
    // else a TRUSTING tx's own plaintext wire meta. An unparseable meta string
    // is treated as no meta (defensive — real producers always emit valid JSON).
    let native_private_meta = match (&privacy, &key_used) {
        (Privacy::Private, Some(kid)) => keys
            .get(kid)
            .and_then(|secret| decrypt_private_meta(sm, session_id, tx_index, secret)),
        _ => None,
    };
    let meta: Option<serde_json::Value> = pending
        .and_then(|p| p.meta_json.clone())
        .or(native_private_meta)
        .or_else(|| trusting_meta.clone())
        .and_then(|s| serde_json::from_str(&s).ok());

    // Native `parseMetaInformation` merge derivation (R2, coValueCore.ts:1539-1579).
    // A merge tx carries `meta.mi`; derive its source made-at and source txID
    // NATIVELY so the engine no longer depends on TS supplying them via pending.
    // TS-supplied `pending` values still take PRECEDENCE (TS remains the
    // orchestrator until R5); native values fill in only what TS omitted. The
    // `previousTransaction`-fallback arms (`meta.t`/`meta.s` absent) are left to
    // pending — see the R2 report's deferral note.
    let (native_src_made_at, native_after_current, native_src_txid) =
        derive_merge_source(meta.as_ref(), current_made_at);
    let is_merge = meta.as_ref().is_some_and(|m| m.get("mi").is_some());

    // Source made-at: pending wins; else native. `source_after_current` is the
    // tamper flag, from whichever source is in effect.
    let (source_made_at, source_after_current) = match pending.and_then(|p| p.source_made_at) {
        Some(s) => (Some(s), s > current_made_at),
        None => (native_src_made_at, native_after_current),
    };
    let effective_made_at = source_made_at.unwrap_or(current_made_at);

    let (source_session_id, source_tx_index) = match pending.and_then(|p| p.source_tx_id.clone()) {
        Some((sid, idx)) => (Some(sid), Some(idx)),
        None => match native_src_txid {
            Some((sid, idx)) => (Some(sid), Some(idx)),
            None => (None, None),
        },
    };

    GroupTxView {
        session_id: session_id.to_string(),
        tx_index,
        author: author_from_session_id(session_id).to_string(),
        current_made_at,
        effective_made_at,
        privacy,
        changes,
        meta,
        source_session_id,
        source_tx_index,
        key_used,
        source_after_current,
        is_merge,
    }
}

/// Port of the `"mi" in meta` arm of `parseMetaInformation`
/// (`coValueCore.ts:1539-1579`), for the self-contained cases (`meta.t` /
/// `meta.s` present). Returns `(sourceTxMadeAt, sourceMadeAt>currentMadeAt,
/// sourceTxID)`:
///
/// - `sourceTxMadeAt = currentMadeAt - meta.t` when `meta.t` is present. `meta.t`
///   is a signed delta; a NEGATIVE `t` yields a source time AFTER `currentMadeAt`
///   (the tamper the check defends against). The returned made-at is clamped to
///   `u64` (`0` if it would be negative — only reachable when `t > currentMadeAt`,
///   which real producers never emit), while the boolean reports the true
///   `> currentMadeAt` comparison in signed space.
/// - `sourceTxID = { sessionID: meta.s, txIndex: meta.mi }` when `meta.s` is
///   present. The `meta.s`-absent fallback (`previousTransaction.txID.sessionID`)
///   needs cross-tx state and is left to TS `pending` for now.
fn derive_merge_source(
    meta: Option<&serde_json::Value>,
    current_made_at: u64,
) -> (Option<u64>, bool, Option<(String, u32)>) {
    let m = match meta {
        Some(m) if m.get("mi").is_some() => m,
        _ => return (None, false, None),
    };
    let mi = m.get("mi").and_then(|v| v.as_u64()).unwrap_or(0) as u32;

    let (src_made_at, after_current) = match m.get("t").and_then(|v| v.as_i64()) {
        Some(t) => {
            let source = current_made_at as i128 - t as i128;
            let after = source > current_made_at as i128;
            let clamped = if source < 0 { 0 } else { source as u64 };
            (Some(clamped), after)
        }
        None => (None, false),
    };

    let src_txid = m
        .get("s")
        .and_then(|v| v.as_str())
        .map(|s| (s.to_string(), mi));

    (src_made_at, after_current, src_txid)
}

/// Natively decrypt a PRIVATE transaction's META (not its changes) into its
/// plaintext JSON string, reusing the session map's decrypt primitive. Returns
/// `None` when there is no meta, the key is wrong, or the session is missing —
/// exactly the cases where TS would leave `transaction.meta` undefined.
fn decrypt_private_meta(
    sm: &SessionMapImpl,
    session_id: &str,
    tx_index: u32,
    key_secret: &str,
) -> Option<String> {
    // A wrong/garbage key (or a missing session) surfaces as Err/None — exactly
    // the cases where TS would leave `transaction.meta` undefined.
    sm.decrypt_transaction_meta(session_id, tx_index, key_secret)
        .unwrap_or_default()
}

/// Collect every transaction of `sm` into views, in session-insertion order,
/// `tx_index` ascending within each session. Each transaction JSON is parsed
/// exactly once. `pending_info` supplies optional source times, decrypted
/// meta, and merge source identity, keyed by `(session_id, tx_index)`; see
/// [`GroupTxView::effective_made_at`], [`GroupTxView::meta`],
/// [`GroupTxView::source_session_id`].
pub fn collect_group_txs(sm: &SessionMapImpl, pending_info: &[PendingTxIn]) -> Vec<GroupTxView> {
    collect_group_txs_keyed(sm, pending_info, &HashMap::new())
}

/// Like [`collect_group_txs`], but also given the `NodeCore` key store so PRIVATE
/// transactions have their meta decrypted natively (R2). The engine passes its
/// keys here so fww / branch-pointer / merge-source meta work for private txs
/// without a TS-supplied `pending.metaJson`.
pub fn collect_group_txs_keyed(
    sm: &SessionMapImpl,
    pending_info: &[PendingTxIn],
    keys: &HashMap<String, String>,
) -> Vec<GroupTxView> {
    // Keyed pending lookup — one entry per `(session_id, tx_index)` that the
    // sync/merge layer supplied extra info for. Absence falls back to the
    // tx's own stored fields everywhere below.
    let pending_by_key: HashMap<(&str, u32), &PendingTxIn> = pending_info
        .iter()
        .map(|p| ((p.session_id.as_str(), p.tx_index), p))
        .collect();

    let mut views = Vec::new();
    for (session_id, tx_jsons) in sm.iter_session_transactions() {
        for (tx_index, tx_json) in tx_jsons.iter().enumerate() {
            let tx_index = tx_index as u32;
            let pending = pending_by_key.get(&(session_id, tx_index)).copied();
            views.push(build_tx_view(
                sm, session_id, tx_index, tx_json, pending, keys,
            ));
        }
    }
    views
}

/// Collect ONLY the transactions whose index is at/after `old_counts[session]`
/// (all transactions of sessions absent from `old_counts`) — the transactions
/// appended since a prior [`collect_group_txs_keyed`] whose per-session counts
/// were `old_counts`. Views are built identically to the full collect, in the
/// same session-insertion / tx-index order, so the caller can sort the suffix in
/// isolation and get the same tail a full sort would produce (used by the
/// engine's safe incremental-validation fast-path).
pub fn collect_group_txs_after(
    sm: &SessionMapImpl,
    pending_info: &[PendingTxIn],
    old_counts: &HashMap<String, u32>,
    keys: &HashMap<String, String>,
) -> Vec<GroupTxView> {
    let pending_by_key: HashMap<(&str, u32), &PendingTxIn> = pending_info
        .iter()
        .map(|p| ((p.session_id.as_str(), p.tx_index), p))
        .collect();

    let mut views = Vec::new();
    for (session_id, tx_jsons) in sm.iter_session_transactions() {
        // Seek straight to the first NEW index instead of scanning every stored
        // transaction and `continue`-ing over the old ones: that scan was O(total
        // history) per ingest — quadratic across a session's lifetime — even
        // though only the suffix is ever built. Indexing the tail slice makes the
        // per-ingest cost O(new transactions).
        let start = old_counts.get(session_id).copied().unwrap_or(0) as usize;
        if start >= tx_jsons.len() {
            continue;
        }
        for (offset, tx_json) in tx_jsons[start..].iter().enumerate() {
            let tx_index = (start + offset) as u32;
            let pending = pending_by_key.get(&(session_id, tx_index)).copied();
            views.push(build_tx_view(
                sm, session_id, tx_index, tx_json, pending, keys,
            ));
        }
    }
    views
}

/// `compareTransactions` port (`coValueCore.ts:1842-1855`) + STABLE sort.
///
/// `effective_made_at` ascending. On ties, the comparison uses each side's
/// EFFECTIVE identity — `txID = sourceTxID ?? currentTxID`
/// (`coValueCore.ts:157-159`): effective session id is
/// `source_session_id.unwrap_or(session_id)`, effective tx index is
/// `source_tx_index.unwrap_or(tx_index)`. Same-effective-session pairs order
/// by effective tx index; different-effective-session pairs compare
/// [`Equal`](core::cmp::Ordering::Equal) so the stable sort preserves the
/// session-insertion order built by [`collect_group_txs`]. For a transaction
/// with no source identity this collapses to the original current-session-only
/// rule.
pub fn sort_for_validation(txs: &mut [GroupTxView]) {
    txs.sort_by(|a, b| match a.effective_made_at.cmp(&b.effective_made_at) {
        core::cmp::Ordering::Equal => {
            let a_session = a.source_session_id.as_deref().unwrap_or(&a.session_id);
            let b_session = b.source_session_id.as_deref().unwrap_or(&b.session_id);
            if a_session == b_session {
                let a_index = a.source_tx_index.unwrap_or(a.tx_index);
                let b_index = b.source_tx_index.unwrap_or(b.tx_index);
                a_index.cmp(&b_index)
            } else {
                core::cmp::Ordering::Equal
            }
        }
        other => other,
    });
}

// =====================================================================
// Test-support: fixture serde structs (reused by later group-engine tasks)
// =====================================================================

#[cfg(test)]
pub(crate) mod fixtures {
    use serde::Deserialize;
    use std::collections::HashMap;

    use crate::core::SessionMapImpl;

    /// One session's raw transaction wire JSON plus its commit signature, as
    /// stored in a fixture file.
    #[allow(dead_code)]
    #[derive(Debug, Clone, Deserialize)]
    pub struct FixtureSession {
        #[serde(rename = "sessionId")]
        pub session_id: String,
        #[serde(rename = "signerId", default)]
        pub signer_id: Option<String>,
        /// Raw wire-JSON transaction strings; each parses to a `Transaction`.
        pub transactions: Vec<String>,
        #[serde(rename = "lastSignature")]
        pub last_signature: String,
    }

    #[derive(Debug, Clone, Deserialize)]
    pub struct FixtureCovalue {
        #[serde(rename = "coId")]
        pub co_id: String,
        #[serde(rename = "headerJson")]
        pub header_json: String,
        pub sessions: Vec<FixtureSession>,
    }

    /// Wire shape of a merged verdict's source identity in fixtures — same
    /// casing as the pending-tx wire shape (`sessionID`, capital ID).
    #[allow(dead_code)]
    #[derive(Debug, Clone, Deserialize)]
    pub struct FixtureSourceTxId {
        #[serde(rename = "sessionID")]
        pub session_id: String,
        #[serde(rename = "txIndex")]
        pub tx_index: u32,
    }

    /// A per-transaction validation verdict, keyed by coId in
    /// [`FixtureFile::verdicts`]. The ORDER of a coId's verdict list is the
    /// expected validation order — `collect_group_txs` + `sort_for_validation`
    /// must reproduce it.
    /// Read by Task 4 (validation); kept here so the fixture parses fully.
    /// The `outcome`/`sourceMadeAt`/`sourceTxId`/`metaJson` fields are the
    /// stage-3 "rich verdict" extensions (see `merged_tx_ties` fixture); kept
    /// optional so pre-stage-3 fixtures (with only `valid`/`reason`) still
    /// parse.
    #[allow(dead_code)]
    #[derive(Debug, Clone, Deserialize)]
    pub struct FixtureVerdict {
        #[serde(rename = "sessionId")]
        pub session_id: String,
        #[serde(rename = "txIndex")]
        pub tx_index: u32,
        pub valid: bool,
        pub reason: Option<String>,
        #[serde(default)]
        pub outcome: Option<String>,
        #[serde(rename = "sourceMadeAt", default)]
        pub source_made_at: Option<u64>,
        #[serde(rename = "sourceTxId", default)]
        pub source_tx_id: Option<FixtureSourceTxId>,
        #[serde(rename = "metaJson", default)]
        pub meta_json: Option<String>,
    }

    /// Read by Task 4 (role resolution); kept here so the fixture parses fully.
    #[allow(dead_code)]
    #[derive(Debug, Clone, Deserialize)]
    pub struct FixtureRoleQuery {
        #[serde(rename = "groupId")]
        pub group_id: String,
        pub member: String,
        #[serde(rename = "atTime")]
        pub at_time: Option<u64>,
        // `null` in fixtures means "the member has no role at this time".
        #[serde(rename = "expectedRole")]
        pub expected_role: Option<String>,
    }

    /// Parsed shape of a `data/group_engine/*.json` fixture file.
    #[allow(dead_code)]
    #[derive(Debug, Clone, Deserialize)]
    pub struct FixtureFile {
        #[serde(default)]
        pub description: Option<String>,
        pub covalues: Vec<FixtureCovalue>,
        #[serde(default)]
        pub verdicts: HashMap<String, Vec<FixtureVerdict>>,
        #[serde(default, rename = "roleQueries")]
        pub role_queries: Vec<FixtureRoleQuery>,
    }

    impl FixtureFile {
        /// Load a fixture from `data/group_engine/<name>.json` relative to the
        /// crate root (where `cargo test` runs).
        pub fn load(name: &str) -> Self {
            let path = format!("data/group_engine/{name}.json");
            let text =
                std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("read {path}: {e}"));
            serde_json::from_str(&text).unwrap_or_else(|e| panic!("parse {path}: {e}"))
        }
    }

    /// Build a `SessionMapImpl` from a fixture covalue, loading every session's
    /// transactions with signature verification skipped. The group engine reads
    /// already-stored state; it does not re-verify session signatures here, and
    /// the tx views it builds are independent of the signer id.
    pub fn build_session_map(cov: &FixtureCovalue) -> SessionMapImpl {
        let mut sm = SessionMapImpl::new_with_skip_verify(&cov.co_id, &cov.header_json, None, true)
            .expect("fixture header should parse under skip_verify");
        for session in &cov.sessions {
            // `add_transactions` takes a JSON array of transaction OBJECTS; the
            // fixture stores one object per string, so splice them into an array
            // (no re-serialization that could reorder fields).
            let txs_json = format!("[{}]", session.transactions.join(","));
            // signer_id left as None: fixture `signerId`s are account/session
            // ids, not raw verifying keys, and signature verification is skipped
            // anyway — the group engine does not need a public key here.
            sm.add_transactions(
                &session.session_id,
                None,
                &txs_json,
                &session.last_signature,
                true,
            )
            .expect("fixture transactions load under skip_verify");
        }
        sm
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// `cross_session_ties` (group covalue `co_zfF4FnTK4hX5gj2Lzss8Zxp2HTh`):
    /// three sessions, all transactions at the SAME `madeAt`. Extraction must be
    /// session-insertion / txIndex-ascending, and because every effective time is
    /// equal, the stable sort must be a no-op — both reproducing the fixture's
    /// verdict order (8 admin-session txs, then one tx each from the two
    /// conflicting sessions).
    #[test]
    fn cross_session_ties_extraction_and_order_match_verdicts() {
        let fix = fixtures::FixtureFile::load("cross_session_ties");
        let cov = fix
            .covalues
            .iter()
            .find(|c| c.co_id == "co_zfF4FnTK4hX5gj2Lzss8Zxp2HTh")
            .expect("ties group covalue present");

        let sm = fixtures::build_session_map(cov);
        let collected = collect_group_txs(&sm, &[]);

        let verdicts = fix
            .verdicts
            .get("co_zfF4FnTK4hX5gj2Lzss8Zxp2HTh")
            .expect("ties verdicts present");

        // Extraction order already equals the verdict (validation) order.
        assert_eq!(collected.len(), verdicts.len(), "tx count");
        for (v, vd) in collected.iter().zip(verdicts.iter()) {
            assert_eq!(v.session_id, vd.session_id, "session order");
            assert_eq!(v.tx_index, vd.tx_index, "tx_index order");
            // All equal madeAt, no pending info -> effective == current.
            assert_eq!(v.current_made_at, 1_700_000_000_000, "current_made_at");
            assert_eq!(v.effective_made_at, v.current_made_at, "effective_made_at");
            assert_eq!(v.privacy, Privacy::Trusting, "privacy");
            assert!(v.changes.is_some(), "trusting tx must parse changes");
        }

        // Stable sort of an all-equal set is a no-op.
        let mut sorted = collected.clone();
        sort_for_validation(&mut sorted);
        let key = |v: &GroupTxView| (v.session_id.clone(), v.tx_index);
        assert_eq!(
            sorted.iter().map(key).collect::<Vec<_>>(),
            collected.iter().map(key).collect::<Vec<_>>(),
            "stable sort must preserve insertion order on equal madeAt"
        );
    }

    /// `basic_roles` (group covalue, single session, 20 trusting txs with
    /// monotonically non-decreasing `madeAt` in txIndex order). Pins: same-session
    /// ties break by txIndex, and a single session's txIndex order is already the
    /// sorted order.
    #[test]
    fn basic_roles_single_session_order() {
        let fix = fixtures::FixtureFile::load("basic_roles");
        let cov = &fix.covalues[0];
        assert_eq!(cov.co_id, "co_zSwsoHJ9ytViWJyoLeMwG8GLJ3T");

        let sm = fixtures::build_session_map(cov);
        let mut views = collect_group_txs(&sm, &[]);

        assert_eq!(views.len(), 20, "20 trusting txs in the admin session");
        for (i, v) in views.iter().enumerate() {
            assert_eq!(v.tx_index, i as u32, "tx_index ascending");
            assert_eq!(v.privacy, Privacy::Trusting);
            assert!(v.changes.is_some());
            assert_eq!(v.effective_made_at, v.current_made_at, "no pending info");
        }

        // madeAt is non-decreasing in txIndex order in this fixture, so the
        // single-session sort (ties -> txIndex) is a no-op.
        let before: Vec<u32> = views.iter().map(|v| v.tx_index).collect();
        sort_for_validation(&mut views);
        let after: Vec<u32> = views.iter().map(|v| v.tx_index).collect();
        assert_eq!(before, after, "single-session sort preserves txIndex order");
    }

    /// `private_tx_in_group` (group covalue): 4 trusting txs followed by one
    /// private tx. A private tx must yield `Privacy::Private` with `changes`
    /// `None` (changes are encrypted/opaque here); trusting txs parse changes.
    #[test]
    fn private_tx_view_has_no_changes() {
        let fix = fixtures::FixtureFile::load("private_tx_in_group");
        let cov = &fix.covalues[0];
        let sm = fixtures::build_session_map(cov);
        let views = collect_group_txs(&sm, &[]);

        assert_eq!(views.len(), 5);
        for v in &views[0..4] {
            assert_eq!(v.privacy, Privacy::Trusting);
            assert!(v.changes.is_some(), "trusting tx parses changes");
        }
        let private = &views[4];
        assert_eq!(private.privacy, Privacy::Private);
        assert!(private.changes.is_none(), "private tx changes must be None");
        assert_eq!(private.current_made_at, 1_783_120_267_022);
    }

    /// Synthetic test pinning all three comparator branches directly:
    /// different `madeAt` orders ascending; equal `madeAt` within a session
    /// orders by txIndex; equal `madeAt` across sessions preserves insertion
    /// order (stable).
    #[test]
    fn sort_for_validation_pins_three_branches() {
        fn view(session: &str, tx_index: u32, effective_made_at: u64) -> GroupTxView {
            GroupTxView {
                session_id: session.to_string(),
                tx_index,
                author: author_from_session_id(session).to_string(),
                current_made_at: effective_made_at,
                effective_made_at,
                privacy: Privacy::Trusting,
                changes: Some(vec![]),
                meta: None,
                source_session_id: None,
                source_tx_index: None,
                key_used: None,
                source_after_current: false,
                is_merge: false,
            }
        }

        // Insertion order: s1/0, s2/0, s1/1, s3/0
        let mut txs = vec![
            view("co_a_session_x", 0, 200),
            view("co_b_session_y", 0, 100), // earlier madeAt -> sorts first
            view("co_a_session_x", 1, 200),
            view("co_c_session_z", 0, 200),
        ];
        sort_for_validation(&mut txs);

        let order: Vec<(String, u32)> = txs
            .iter()
            .map(|t| (t.session_id.clone(), t.tx_index))
            .collect();
        assert_eq!(
            order,
            vec![
                ("co_b_session_y".to_string(), 0), // madeAt 100 ascending
                ("co_a_session_x".to_string(), 0), // madeAt 200, same session -> txIndex
                ("co_a_session_x".to_string(), 1),
                ("co_c_session_z".to_string(), 0), // madeAt 200, cross-session -> stable
            ]
        );
    }

    /// `pending_info` source times override `current_made_at` for ORDERING only:
    /// `effective_made_at = source_made_at.unwrap_or(current_made_at)`, while
    /// `current_made_at` is unchanged.
    #[test]
    fn pending_source_made_at_drives_ordering() {
        let fix = fixtures::FixtureFile::load("cross_session_ties");
        let cov = fix
            .covalues
            .iter()
            .find(|c| c.co_id == "co_zfF4FnTK4hX5gj2Lzss8Zxp2HTh")
            .unwrap();
        let sm = fixtures::build_session_map(cov);

        // Push session B's single tx to a much later source time so it lands last.
        let b_session = "co_zUGQrkaYiZrjKaNgqQgARcDd54d_session_zG8MqseX8L3A";
        let pending = vec![PendingTxIn {
            session_id: b_session.to_string(),
            tx_index: 0,
            source_made_at: Some(1_800_000_000_000),
            meta_json: None,
            source_tx_id: None,
        }];
        let mut views = collect_group_txs(&sm, &pending);
        sort_for_validation(&mut views);

        let b = views
            .iter()
            .find(|v| v.session_id == b_session)
            .expect("session B present");
        assert_eq!(b.current_made_at, 1_700_000_000_000, "current unchanged");
        assert_eq!(
            b.effective_made_at, 1_800_000_000_000,
            "effective overridden"
        );
        assert_eq!(
            views.last().unwrap().session_id,
            b_session,
            "later effective time sorts last"
        );
    }

    /// Source-identity tie-break (porter note 9 / `coValueCore.ts:157-159`,
    /// `txID = sourceTxID ?? currentTxID`): two transactions stored in
    /// DIFFERENT current sessions, both merged from the SAME source session,
    /// at equal `effective_made_at` — the tie must be broken by SOURCE
    /// txIndex, not left `Equal` (which the old current-session-only rule
    /// would do, since `a.session_id != b.session_id`).
    #[test]
    fn sort_for_validation_source_identity_tie_break() {
        fn view(
            session: &str,
            tx_index: u32,
            source_session: &str,
            source_tx_index: u32,
        ) -> GroupTxView {
            GroupTxView {
                session_id: session.to_string(),
                tx_index,
                author: author_from_session_id(session).to_string(),
                current_made_at: 500,
                effective_made_at: 500,
                privacy: Privacy::Trusting,
                changes: Some(vec![]),
                meta: None,
                source_session_id: Some(source_session.to_string()),
                source_tx_index: Some(source_tx_index),
                key_used: None,
                source_after_current: false,
                is_merge: false,
            }
        }

        // Both stored in different CURRENT sessions, both merged from the same
        // source session; source txIndex 3 must sort after source txIndex 1,
        // even though inserted here in the opposite (reverse) order.
        let mut txs = vec![
            view("co_a_current_session", 5, "co_shared_source_session", 3),
            view("co_b_current_session", 2, "co_shared_source_session", 1),
        ];
        sort_for_validation(&mut txs);

        let order: Vec<u32> = txs.iter().map(|t| t.source_tx_index.unwrap()).collect();
        assert_eq!(
            order,
            vec![1, 3],
            "same-source-session tie orders by SOURCE txIndex, not current (session, txIndex)"
        );
    }

    /// Meta precedence: pending's decrypted `meta_json` overrides a TRUSTING
    /// tx's own wire `meta` field when both are present.
    #[test]
    fn pending_meta_overrides_trusting_wire_meta() {
        let fix = fixtures::FixtureFile::load("merged_tx_ties");
        let cov = &fix.covalues[0];
        assert_eq!(cov.co_id, "co_zSKK5oFqS8LcD3Rj14nYJQf5S6B");
        let sm = fixtures::build_session_map(cov);

        // txIndex 2 is a trusting tx whose wire `meta` is
        // `{"mi":1,"t":10000,"s":...,"b":...}` (see the fixture file).
        let no_pending = collect_group_txs(&sm, &[]);
        let wire_meta = no_pending[2]
            .meta
            .clone()
            .expect("trusting wire meta parses");
        assert_eq!(wire_meta["mi"], 1, "wire meta read when no pending meta");

        let session_id = &no_pending[2].session_id;
        let pending = vec![PendingTxIn {
            session_id: session_id.clone(),
            tx_index: 2,
            source_made_at: None,
            meta_json: Some(r#"{"mi":999,"overridden":true}"#.to_string()),
            source_tx_id: None,
        }];
        let with_pending = collect_group_txs(&sm, &pending);
        let overridden_meta = with_pending[2].meta.clone().expect("pending meta parses");
        assert_eq!(
            overridden_meta["mi"], 999,
            "pending meta_json overrides the trusting tx's own wire meta"
        );
        assert_eq!(overridden_meta["overridden"], true);
    }

    /// `merged_tx_ties` fixture parses fully, including the stage-3 "rich
    /// verdict" fields (`outcome`, `sourceMadeAt`, `sourceTxId`, `metaJson`)
    /// that Task 3 will consume.
    #[test]
    fn merged_tx_ties_fixture_parses_rich_verdict_fields() {
        let fix = fixtures::FixtureFile::load("merged_tx_ties");
        let verdicts = fix
            .verdicts
            .get("co_zSKK5oFqS8LcD3Rj14nYJQf5S6B")
            .expect("merged_tx_ties verdicts present");
        assert_eq!(verdicts.len(), 5);

        assert_eq!(verdicts[0].outcome.as_deref(), Some("valid"));
        assert!(verdicts[0].source_tx_id.is_none());
        assert!(verdicts[0].meta_json.is_none());

        assert_eq!(
            verdicts[1].meta_json.as_deref(),
            Some(r#"{"branch":"feature-branch","ownerId":"co_zQRoiJcPP4nRGqf8bnMWoxYJkZH"}"#)
        );

        let tx2 = &verdicts[2];
        assert_eq!(tx2.source_made_at, Some(1_700_000_010_000));
        let source_tx_id = tx2.source_tx_id.as_ref().expect("sourceTxId present");
        assert_eq!(source_tx_id.tx_index, 1);
        assert!(source_tx_id.session_id.contains("_session_zRRaQY3Uonxr"));
        assert!(tx2.meta_json.as_deref().unwrap().contains("\"mi\":1"));

        let tx3 = &verdicts[3];
        assert_eq!(
            tx3.source_tx_id
                .as_ref()
                .expect("sourceTxId present")
                .tx_index,
            2
        );
    }

    // === R2: native parseMetaInformation merge-source derivation ===

    /// A merge tx `{mi, t, s}` derives `sourceTxMadeAt = currentMadeAt - t` and
    /// `sourceTxID = {s, mi}` natively (no pending needed); a positive `t` is not
    /// tamper.
    #[test]
    fn derive_merge_source_from_t_and_s() {
        let meta = serde_json::json!({"mi": 3, "t": 10_000, "s": "co_zSrc_session_zX"});
        let (made, after, txid) = super::derive_merge_source(Some(&meta), 1_700_000_100_000);
        assert_eq!(made, Some(1_700_000_090_000), "currentMadeAt - t");
        assert!(!after, "positive t is a back-in-time source, never tamper");
        assert_eq!(txid, Some(("co_zSrc_session_zX".to_string(), 3)));
    }

    /// A NEGATIVE `t` back-dates the source to AFTER currentMadeAt — the tamper
    /// the anti-tamper check defends against (writing after a revocation).
    #[test]
    fn derive_merge_source_negative_t_flags_tamper() {
        let meta = serde_json::json!({"mi": 1, "t": -5_000});
        let (made, after, txid) = super::derive_merge_source(Some(&meta), 1_000_000);
        assert_eq!(made, Some(1_005_000), "current - (negative t) > current");
        assert!(after, "source after currentMadeAt → tamper flag set");
        assert_eq!(txid, None, "no meta.s → sourceTxID left to pending");
    }

    /// No `mi` → not a merge tx: nothing derived, no tamper.
    #[test]
    fn derive_merge_source_non_merge_is_inert() {
        let meta = serde_json::json!({"fww": "lock"});
        assert_eq!(
            super::derive_merge_source(Some(&meta), 100),
            (None, false, None)
        );
        assert_eq!(super::derive_merge_source(None, 100), (None, false, None));
    }

    /// The full builder wires the native derivation onto the view: a trusting tx
    /// whose wire meta is a merge `{mi, t, s}` gets `effective_made_at`,
    /// `source_session_id`, and `is_merge` populated with NO pending supplied.
    #[test]
    fn build_tx_view_populates_native_merge_fields_without_pending() {
        use crate::core::{CoValueHeader, NullableString, RulesetDef, Uniqueness};
        let header = CoValueHeader {
            created_at: NullableString::Missing,
            meta: None,
            ruleset: RulesetDef::unsafe_allow_all(),
            co_type: "comap".to_string(),
            uniqueness: Uniqueness::String("mergemeta".to_string()),
        };
        let header_json = serde_json::to_string(&header).unwrap();
        let co_id = crate::hash::blake3::short_hash_with_prefix(header_json.as_bytes(), "co_z");
        let mut sm =
            SessionMapImpl::new_with_skip_verify(&co_id, &header_json, None, true).unwrap();

        // A trusting tx carrying merge meta as its (stringified) wire meta.
        let current = 1_700_000_100_000u64;
        let changes =
            serde_json::to_string(&serde_json::json!([{"op":"set","key":"k","value":1}])).unwrap();
        let wire_meta =
            serde_json::json!({"mi": 7, "t": 100_000, "s": "co_zSrc_session_zY"}).to_string();
        let tx = format!(
            r#"{{"privacy":"trusting","madeAt":{current},"changes":{},"meta":{}}}"#,
            serde_json::to_string(&changes).unwrap(),
            serde_json::to_string(&wire_meta).unwrap(),
        );
        sm.add_transactions("co_zA_session_zM", None, &format!("[{tx}]"), "sig", true)
            .unwrap();

        let views = collect_group_txs(&sm, &[]);
        let v = &views[0];
        assert!(v.is_merge, "meta.mi present → is_merge");
        assert_eq!(v.effective_made_at, current - 100_000, "native source time");
        assert_eq!(v.source_session_id.as_deref(), Some("co_zSrc_session_zY"));
        assert_eq!(v.source_tx_index, Some(7));
        assert!(!v.source_after_current);
    }
}
