use std::collections::HashMap;

use crate::core::co_map::{ensure_co_map, CoMapView};
use crate::core::group_engine::engine::{
    generation_of, role_of as engine_role_of,
    validate_transactions as engine_validate_transactions,
    validate_transactions_delta as engine_validate_transactions_delta, verdicts_of,
    GroupEngineState, VerdictDelta,
};
use crate::core::group_engine::tx_view::PendingTxIn;
use crate::core::group_engine::types::Role;
use crate::core::session_map::{SessionMapError, SessionMapImpl};

/// Node-level registry owning one SessionMapImpl per CoValue, keyed by CoID.
/// One instance per LocalNode. Stage 2+ builds cross-CoValue features
/// (group engine, permissions) on top of this registry.
///
/// The built group engines live in a SEPARATE map from the session maps so that
/// a recursive engine build can borrow the session maps immutably while it
/// mutates the engine store (see `group_engine::engine`'s borrow-strategy note).
pub struct NodeCore {
    covalues: HashMap<String, SessionMapImpl>,
    engines: HashMap<String, GroupEngineState>,
    /// R0 coMap materialization (experimental): per-covalue materialized view,
    /// keyed like `engines` by per-session tx-counts. A separate field so a
    /// build can borrow `covalues`/`engines` while mutating this store.
    co_maps: HashMap<String, CoMapView>,
    /// R1 key store: `KeyID -> KeySecret`, GLOBAL (not per-covalue). TS unseals
    /// read-key secrets (via account sealer keys + revelation chains — that
    /// stays in TS) and feeds each one here as it learns it; native private-tx
    /// decryption during materialization is the ONLY consumer. A given `KeyID`
    /// always resolves to the same secret regardless of which covalue asks, so a
    /// global map mirrors TS's effective behavior: TS's `readKeyCache` is
    /// per-covalue, but `getUncachedReadKey`/`getReadKey` are pure functions of
    /// the `KeyID` (content-addressed key material), so caching globally is
    /// equivalent.
    ///
    /// SECURITY: providing a secret moves it into native memory for the process
    /// lifetime. Under wasm this is the SAME trust domain as the page (linear
    /// memory is already inspectable by the host JS); under napi it is process
    /// memory. Neither is worse than the secret's existing residence on the TS
    /// heap. There is deliberately NO getter that hands a secret back across the
    /// boundary — decryption keeps secrets inside Rust.
    keys: HashMap<String, String>,
    /// Bumped whenever a NEW (or changed) secret is provided. Part of each
    /// coMap view's freshness key so a view lazily rebuilds when a
    /// previously-missing key finally arrives (the retry path).
    keys_version: u64,
}

/// The compact result of [`NodeCore::ingest_and_materialize`] — the ONLY thing
/// that crosses the FFI boundary per content chunk (the R0-winning delta shape).
/// It deliberately omits the per-transaction verdict array: validation happens
/// in-crate (the engine ensure path consumes verdicts to materialize the view),
/// so the 2000-verdict-per-chunk marshalling the R2.5 report flagged never
/// occurs on this path.
#[derive(Debug, Clone)]
pub struct IngestOutcome {
    /// The validation engine's full-recompute generation after this ingest.
    /// A TS validation cursor can advance on `(generation, count)` WITHOUT
    /// receiving the verdicts themselves — a generation match means the tail
    /// only extended, a change means a recompute happened.
    pub generation: u64,
    /// Total verdict count after this ingest (the TS validation cursor's `count`).
    pub count: u32,
    /// The coMap view's monotonic version after materialization (the delta cursor).
    pub view_version: u64,
    /// RICH delta `{version, reset, changedKeys}` since the caller's
    /// `since_version` — each `changedKeys[k]` is the full `MapOp[]` op-list for
    /// a changed key, the payload a TS `RawCoMap` rebuilds `ops`/`latest` from.
    /// `reset` signals the caller to clear and rebuild (a full recompute
    /// happened). Serialized ONCE per ingest, O(changed keys).
    pub delta_json: String,
}

impl NodeCore {
    pub fn new() -> Self {
        NodeCore {
            covalues: HashMap::new(),
            engines: HashMap::new(),
            co_maps: HashMap::new(),
            keys: HashMap::new(),
            keys_version: 0,
        }
    }

    // === R1 key store (experimental) ===

    /// Feed a `KeyID -> KeySecret` mapping learned by TS (idempotent). A brand
    /// new key — or a changed secret for a known id — bumps the keys-version so
    /// coMap views that skipped a private tx for want of this key rebuild on
    /// their next materialize. Re-providing an identical secret is a no-op (no
    /// version bump, no spurious rebuild). Secrets never leave Rust again.
    pub fn provide_key_secret(&mut self, key_id: &str, key_secret: &str) {
        match self.keys.get(key_id) {
            Some(existing) if existing == key_secret => {}
            _ => {
                self.keys.insert(key_id.to_string(), key_secret.to_string());
                self.keys_version += 1;
            }
        }
    }

    /// Whether a secret for `key_id` has been provided.
    pub fn has_key_secret(&self, key_id: &str) -> bool {
        self.keys.contains_key(key_id)
    }

    /// The `KeyID`s that `co_id`'s materialized view still needs a secret for
    /// (private txs skipped for want of a key). Empty if the view is fully
    /// decrypted or not yet materialized.
    pub fn missing_key_ids(&self, co_id: &str) -> Vec<String> {
        self.co_maps
            .get(co_id)
            .map(|v| v.missing_key_ids())
            .unwrap_or_default()
    }

    /// Create (or replace) the SessionMapImpl for a CoValue.
    /// Replace-on-existing matches current TS semantics, where constructing a
    /// new VerifiedState for an already-known id creates a fresh SessionMap.
    pub fn create_co_value(
        &mut self,
        co_id: &str,
        header_json: &str,
        max_tx_size: Option<u32>,
        skip_verify: bool,
    ) -> Result<(), SessionMapError> {
        let session_map =
            SessionMapImpl::new_with_skip_verify(co_id, header_json, max_tx_size, skip_verify)?;
        self.covalues.insert(co_id.to_string(), session_map);
        // Any cached engine/view for this id is now stale (fresh session map).
        self.engines.remove(co_id);
        self.co_maps.remove(co_id);
        Ok(())
    }

    pub fn has_co_value(&self, co_id: &str) -> bool {
        self.covalues.contains_key(co_id)
    }

    /// Returns true if an entry was removed. Absent id is a no-op (false).
    pub fn remove_co_value(&mut self, co_id: &str) -> bool {
        self.engines.remove(co_id);
        self.co_maps.remove(co_id);
        self.covalues.remove(co_id).is_some()
    }

    /// Validate every transaction of `co_id`, returning the verdicts in
    /// validation order. Ensures the (cross-CoValue) group engine is fresh,
    /// rebuilding it — and any parent/owner engines it depends on — as needed.
    /// (Stage 2 name: `validate_group`; this is Stage 3's unified
    /// `validateTransactions` surface, which subsumes it.)
    ///
    /// `co_id` itself must already be registered: an unregistered primary
    /// coId is API misuse (`UnknownCoValue`), consistent with `get`/`get_mut`.
    /// A dependency (parent group / owning account) discovered missing during
    /// the recursive build still surfaces as `CoValueNotLoaded`, unchanged.
    pub fn validate_transactions(
        &mut self,
        co_id: &str,
        pending: &[PendingTxIn],
    ) -> Result<Vec<crate::core::group_engine::engine::Verdict>, SessionMapError> {
        if !self.covalues.contains_key(co_id) {
            return Err(SessionMapError::UnknownCoValue(co_id.to_string()));
        }
        let Self {
            covalues,
            engines,
            co_maps: _,
            keys,
            keys_version,
        } = self;
        engine_validate_transactions(covalues, engines, keys, *keys_version, co_id, pending)
    }

    /// Delta counterpart of [`validate_transactions`]: returns only the verdicts
    /// the caller has not seen, given its `(since_generation, since_count)`
    /// cursor. On a generation match returns `verdicts[since_count..]`; on a
    /// mismatch (a full recompute reordered/flipped verdicts, or a fresh cursor)
    /// returns the whole list with `from_index = 0`. Same error contract and
    /// engine-freshness semantics as [`validate_transactions`]; the delta shape
    /// keeps per-ingest marshalling and TS re-apply O(new), not O(history).
    pub fn validate_transactions_delta(
        &mut self,
        co_id: &str,
        since_generation: u64,
        since_count: u32,
        pending: &[PendingTxIn],
    ) -> Result<VerdictDelta, SessionMapError> {
        if !self.covalues.contains_key(co_id) {
            return Err(SessionMapError::UnknownCoValue(co_id.to_string()));
        }
        let Self {
            covalues,
            engines,
            co_maps: _,
            keys,
            keys_version,
        } = self;
        engine_validate_transactions_delta(
            covalues,
            engines,
            keys,
            *keys_version,
            co_id,
            since_generation,
            since_count,
            pending,
        )
    }

    /// Drop the cached validation engine for `co_id`, forcing a full recompute
    /// on the next `validate_transactions` / `role_of`. The TS analogue is
    /// `CoValueCore.resetParsedTransactions` (coValueCore.ts:1318), which
    /// `invalidateDependants` fires on each DEPENDANT of a changed group.
    ///
    /// LOAD-BEARING CALLER CONTRACT: the engine cache is keyed ONLY by
    /// per-session transaction counts — `pending` (decrypted meta / source
    /// identities) is NOT part of the key. If pending changes without a new
    /// transaction (e.g. a private tx's meta decrypts later), verdicts stay
    /// stale until this is called. That mirrors TS exactly (verdicts persist
    /// until `resetParsedTransactions`), so the TS delegation MUST call this
    /// wherever TS calls `resetParsedTransactions`, and nowhere else.
    ///
    /// An absent id is a NO-OP (not `UnknownCoValue`): the TS caller invokes
    /// this on dependants that may never have been registered on this node, so
    /// erroring would be hostile — same rationale as `remove_co_value`.
    pub fn reset_validation(&mut self, co_id: &str) {
        self.engines.remove(co_id);
        // The materialized content view is derived from the verdicts, so drop it
        // too — TS `resetParsedTransactions` likewise rebuilds content when a
        // reset flips validity (coValueCore.ts:1349-1358).
        self.co_maps.remove(co_id);
    }

    // === R0 coMap materialization (experimental) ===
    // Three read-boundary candidates over a Rust-resident coMap view.
    // `map_materialize` is the only mutating path (validate + build/append);
    // the read methods (`map_get`, `map_get_at`, `map_snapshot`, `map_delta`)
    // are `&self` and operate on the cached view — a prior `map_materialize`
    // (or ingest) must have run. An unregistered primary coId is
    // `UnknownCoValue`, matching `validate_transactions`/`role_of`.

    /// Materialize (or incrementally refresh) `co_id`'s coMap view, returning its
    /// current monotonic version. Call after each ingest batch.
    pub fn map_materialize(
        &mut self,
        co_id: &str,
        pending: &[PendingTxIn],
    ) -> Result<u64, SessionMapError> {
        if !self.covalues.contains_key(co_id) {
            return Err(SessionMapError::UnknownCoValue(co_id.to_string()));
        }
        let Self {
            covalues,
            engines,
            co_maps,
            keys,
            keys_version,
        } = self;
        ensure_co_map(
            covalues,
            engines,
            co_maps,
            keys,
            *keys_version,
            co_id,
            pending,
        )
    }

    /// Boundary (a): latest value of `key` as a JSON string (`None` = absent /
    /// deleted / not-yet-materialized).
    pub fn map_get(&self, co_id: &str, key: &str) -> Result<Option<String>, SessionMapError> {
        if !self.covalues.contains_key(co_id) {
            return Err(SessionMapError::UnknownCoValue(co_id.to_string()));
        }
        Ok(self
            .co_maps
            .get(co_id)
            .and_then(|v| v.get(key))
            .map(|val| val.to_string()))
    }

    /// Boundary (a): value of `key` at `at_time` (`None` = latest) as a JSON
    /// string.
    pub fn map_get_at(
        &self,
        co_id: &str,
        key: &str,
        at_time: Option<u64>,
    ) -> Result<Option<String>, SessionMapError> {
        if !self.covalues.contains_key(co_id) {
            return Err(SessionMapError::UnknownCoValue(co_id.to_string()));
        }
        Ok(self
            .co_maps
            .get(co_id)
            .and_then(|v| v.get_at(key, at_time))
            .map(|val| val.to_string()))
    }

    /// Boundary (b): whole materialized map `{key: latestValue}` as a JSON
    /// string (empty object if not yet materialized).
    pub fn map_snapshot(&self, co_id: &str) -> Result<String, SessionMapError> {
        if !self.covalues.contains_key(co_id) {
            return Err(SessionMapError::UnknownCoValue(co_id.to_string()));
        }
        let snapshot = self
            .co_maps
            .get(co_id)
            .map(|v| v.snapshot())
            .unwrap_or_else(|| serde_json::Value::Object(Default::default()));
        Ok(snapshot.to_string())
    }

    /// Boundary (c): `{version, changedKeys, deletedKeys}` since `since_version`
    /// as a JSON string.
    pub fn map_delta(&self, co_id: &str, since_version: u64) -> Result<String, SessionMapError> {
        if !self.covalues.contains_key(co_id) {
            return Err(SessionMapError::UnknownCoValue(co_id.to_string()));
        }
        let delta = self
            .co_maps
            .get(co_id)
            .map(|v| v.delta(since_version))
            .unwrap_or_else(|| {
                serde_json::json!({
                    "version": 0,
                    "changedKeys": {},
                    "deletedKeys": [],
                })
            });
        Ok(delta.to_string())
    }

    /// Boundary (c-rich): `{version, reset, changedKeys}` since `since_version`,
    /// where each `changedKeys[k]` is the full ordered `MapOp[]` op-list for a
    /// changed key — the payload a TS `RawCoMap` rebuilds its `ops`/`latest`
    /// from. See [`crate::core::co_map::CoMapView::delta_rich`].
    pub fn map_delta_rich(
        &self,
        co_id: &str,
        since_version: u64,
    ) -> Result<String, SessionMapError> {
        if !self.covalues.contains_key(co_id) {
            return Err(SessionMapError::UnknownCoValue(co_id.to_string()));
        }
        Ok(self
            .co_maps
            .get(co_id)
            .map(|v| v.delta_rich(since_version))
            .unwrap_or_else(|| {
                r#"{"version":0,"reset":true,"changedKeys":{}}"#.to_string()
            }))
    }

    /// Boundary (c-lazy): the full ordered `MapOp[]` for a SINGLE key as a JSON
    /// string (`[]` if the key is absent or the view is not yet materialized).
    /// The lazy per-key counterpart to [`map_delta_rich`]: a TS `RawCoMap` pulls
    /// this ONLY when a rich accessor (`ops`/`getRaw`/`lastEditAt`/`editsAt`/
    /// `nthEditAt`/atTime/atFrontier) first touches the key, so the hot ingest
    /// path transfers only latest values (the cheap [`map_delta`]) and never the
    /// per-op history of keys nobody inspects.
    pub fn map_ops_for_key(
        &self,
        co_id: &str,
        key: &str,
    ) -> Result<String, SessionMapError> {
        if !self.covalues.contains_key(co_id) {
            return Err(SessionMapError::UnknownCoValue(co_id.to_string()));
        }
        Ok(self
            .co_maps
            .get(co_id)
            .map(|v| v.ops_for_key(key))
            .unwrap_or_else(|| "[]".to_string()))
    }

    /// Parse a `{ sessionID: txCount }` frontier JSON object into the map the
    /// coMap frontier reads expect. A malformed frontier is treated as empty
    /// (every op excluded — the `?? -1` default).
    fn parse_frontier(frontier_json: &str) -> HashMap<String, i64> {
        serde_json::from_str(frontier_json).unwrap_or_default()
    }

    /// Frontier read: latest frontier-visible value of `key` as a JSON string
    /// (`None` = absent). `frontier_json` is `{ sessionID: txCount }`.
    pub fn map_get_at_frontier(
        &self,
        co_id: &str,
        key: &str,
        frontier_json: &str,
    ) -> Result<Option<String>, SessionMapError> {
        if !self.covalues.contains_key(co_id) {
            return Err(SessionMapError::UnknownCoValue(co_id.to_string()));
        }
        let frontier = Self::parse_frontier(frontier_json);
        Ok(self
            .co_maps
            .get(co_id)
            .and_then(|v| v.get_at_frontier(key, &frontier))
            .map(|val| val.to_string()))
    }

    /// Frontier read: whole `{key: latestVisibleValue}` snapshot under
    /// `frontier_json` as a JSON string.
    pub fn map_snapshot_at_frontier(
        &self,
        co_id: &str,
        frontier_json: &str,
    ) -> Result<String, SessionMapError> {
        if !self.covalues.contains_key(co_id) {
            return Err(SessionMapError::UnknownCoValue(co_id.to_string()));
        }
        let frontier = Self::parse_frontier(frontier_json);
        let snapshot = self
            .co_maps
            .get(co_id)
            .map(|v| v.snapshot_at_frontier(&frontier))
            .unwrap_or_else(|| serde_json::Value::Object(Default::default()));
        Ok(snapshot.to_string())
    }

    /// Stage-1 single-call ingest (R3): add a content chunk's transactions to the
    /// raw session log, validate them in-crate, and materialize the coMap view —
    /// all in one FFI crossing, returning only the compact [`IngestOutcome`].
    ///
    /// This collapses the old three-step coMap receive path
    /// (`add_transactions` + `validate_transactions_delta` marshalling every
    /// verdict + TS `VerifiedTransaction` bookkeeping) into a single call whose
    /// return payload is O(changed keys), not O(transactions): the engine ensure
    /// path inside `map_materialize` consumes the verdicts internally, so no
    /// verdict array crosses the boundary.
    ///
    /// The RAW session log is still written (via `add_transactions`), so the TS
    /// sync (`newContentSince`) and storage paths — which read raw sessions from
    /// this same store, independent of the valid-transaction path — are
    /// unaffected.
    ///
    /// `co_id` must be registered (`UnknownCoValue`); `add_transactions` errors
    /// (bad signature, deleted covalue, malformed tx JSON) surface unchanged and
    /// leave no view mutation (materialization only runs after a successful add).
    #[allow(clippy::too_many_arguments)]
    pub fn ingest_and_materialize(
        &mut self,
        co_id: &str,
        session_id: &str,
        signer_id: Option<&str>,
        transactions_json: &str,
        signature: &str,
        skip_verify: bool,
        since_version: u64,
        pending: &[PendingTxIn],
    ) -> Result<IngestOutcome, SessionMapError> {
        // Ingest into the raw session log (the store TS sync/storage also read).
        self.get_mut(co_id)?.add_transactions(
            session_id,
            signer_id,
            transactions_json,
            signature,
            skip_verify,
        )?;

        // Validate (in-crate) + materialize. `map_materialize` runs the engine
        // ensure path and consumes verdicts internally.
        let view_version = self.map_materialize(co_id, pending)?;

        let generation = generation_of(&self.engines, co_id);
        let count = verdicts_of(&self.engines, co_id).len() as u32;
        // RICH delta: full per-op `MapOp[]` for each changed key — the payload a
        // TS `RawCoMap` rebuilds `ops`/`latest` from in one FFI crossing.
        let delta_json = self.map_delta_rich(co_id, since_version)?;

        Ok(IngestOutcome {
            generation,
            count,
            view_version,
            delta_json,
        })
    }

    /// Read-side role of `member` in group `group_id` at `at_time` (`None` =
    /// latest). Builds engines on demand.
    ///
    /// `group_id` itself must already be registered: an unregistered primary
    /// coId is API misuse (`UnknownCoValue`), consistent with `get`/`get_mut`.
    /// A dependency (parent group / owning account) discovered missing during
    /// the recursive build still surfaces as `CoValueNotLoaded`, unchanged.
    pub fn role_of(
        &mut self,
        group_id: &str,
        member: &str,
        at_time: Option<u64>,
    ) -> Result<Option<Role>, SessionMapError> {
        if !self.covalues.contains_key(group_id) {
            return Err(SessionMapError::UnknownCoValue(group_id.to_string()));
        }
        let Self {
            covalues,
            engines,
            co_maps: _,
            keys,
            keys_version,
        } = self;
        engine_role_of(
            covalues,
            engines,
            keys,
            *keys_version,
            group_id,
            member,
            at_time,
        )
    }

    pub fn co_value_count(&self) -> usize {
        self.covalues.len()
    }

    pub fn get(&self, co_id: &str) -> Result<&SessionMapImpl, SessionMapError> {
        self.covalues
            .get(co_id)
            .ok_or_else(|| SessionMapError::UnknownCoValue(co_id.to_string()))
    }

    pub fn get_mut(&mut self, co_id: &str) -> Result<&mut SessionMapImpl, SessionMapError> {
        self.covalues
            .get_mut(co_id)
            .ok_or_else(|| SessionMapError::UnknownCoValue(co_id.to_string()))
    }
}

impl Default for NodeCore {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::session_map::SessionMapError;

    // Build a valid header + matching co_id, mirroring session_map.rs's
    // `test_validation_with_matching_id`. NOTE: `compute_co_id_from_header` is
    // private to session_map.rs, so we rebuild the same computation here via the
    // public `short_hash_with_prefix` (see deviation note in report).
    fn valid_header() -> (String, String) {
        use crate::core::{CoValueHeader, NullableString, RulesetDef, Uniqueness};

        let header = CoValueHeader {
            created_at: NullableString::Missing,
            meta: None,
            ruleset: RulesetDef::unsafe_allow_all(),
            co_type: "comap".to_string(),
            uniqueness: Uniqueness::String("test".to_string()),
        };
        let header_json = serde_json::to_string(&header).unwrap();
        let co_id = crate::hash::blake3::short_hash_with_prefix(header_json.as_bytes(), "co_z");
        (co_id, header_json)
    }

    #[test]
    fn create_has_remove_roundtrip() {
        let (co_id, header_json) = valid_header();
        let mut node = NodeCore::new();
        assert!(!node.has_co_value(&co_id));
        assert_eq!(node.co_value_count(), 0);

        node.create_co_value(&co_id, &header_json, None, false)
            .unwrap();
        assert!(node.has_co_value(&co_id));
        assert_eq!(node.co_value_count(), 1);
        assert!(node.get(&co_id).is_ok());

        assert!(node.remove_co_value(&co_id));
        assert!(!node.has_co_value(&co_id));
        assert_eq!(node.co_value_count(), 0);
    }

    #[test]
    fn remove_absent_is_noop() {
        let mut node = NodeCore::new();
        assert!(!node.remove_co_value("co_zDoesNotExist"));
        // double-remove after create
        let (co_id, header_json) = valid_header();
        node.create_co_value(&co_id, &header_json, None, false)
            .unwrap();
        assert!(node.remove_co_value(&co_id));
        assert!(!node.remove_co_value(&co_id));
    }

    #[test]
    fn get_unknown_covalue_errors() {
        let node = NodeCore::new();
        match node.get("co_zDoesNotExist") {
            Err(SessionMapError::UnknownCoValue(id)) => assert_eq!(id, "co_zDoesNotExist"),
            other => panic!("expected UnknownCoValue, got {other:?}"),
        }
    }

    #[test]
    fn create_replaces_existing_entry() {
        // Matches TS semantics: `new VerifiedState(sameId)` today creates a fresh
        // SessionMap; createCoValue must replace, not error.
        let (co_id, header_json) = valid_header();
        let mut node = NodeCore::new();
        node.create_co_value(&co_id, &header_json, None, false)
            .unwrap();
        node.create_co_value(&co_id, &header_json, None, false)
            .unwrap();
        assert_eq!(node.co_value_count(), 1);
    }

    /// A trusting single-tx chunk over an unsafeAllowAll comap, in the wire
    /// shape `add_transactions` expects (`changes` is a STRINGIFIED JSON array).
    fn trusting_chunk(key: &str, value: serde_json::Value, made_at: u64) -> String {
        let changes =
            serde_json::to_string(&serde_json::json!([{"op":"set","key":key,"value":value}]))
                .unwrap();
        format!(
            r#"[{{"privacy":"trusting","madeAt":{made_at},"changes":{}}}]"#,
            serde_json::to_string(&changes).unwrap()
        )
    }

    #[test]
    fn ingest_and_materialize_returns_compact_delta_no_verdict_marshal() {
        let (co_id, header_json) = valid_header();
        let mut node = NodeCore::new();
        node.create_co_value(&co_id, &header_json, None, true)
            .unwrap();
        let session = "co_zA_session_zS";

        // First chunk: sets "a" = 1.
        let out = node
            .ingest_and_materialize(
                &co_id,
                session,
                None,
                &trusting_chunk("a", serde_json::json!(1), 1_700_000_000_000),
                "sig",
                true,
                0,
                &[],
            )
            .unwrap();
        assert_eq!(out.count, 1, "one verdict after one tx");
        assert!(out.view_version >= 1);
        // The ingest payload is the RICH delta: full MapOp[] per changed key.
        let delta: serde_json::Value = serde_json::from_str(&out.delta_json).unwrap();
        assert_eq!(delta["version"], out.view_version);
        assert_eq!(delta["reset"], serde_json::json!(true), "fresh cursor resyncs");
        let a_ops = delta["changedKeys"]["a"].as_array().unwrap();
        assert_eq!(a_ops.len(), 1);
        assert_eq!(a_ops[0]["change"], serde_json::json!({"op":"set","key":"a","value":1}));
        assert_eq!(a_ops[0]["changeIdx"], serde_json::json!(0));
        assert_eq!(a_ops[0]["trusting"], serde_json::json!(true));
        assert_eq!(a_ops[0]["txID"]["sessionID"], serde_json::json!(session));

        // Second chunk: sets "b" = 2. Delta SINCE the previous view version must
        // carry only the newly-changed key (O(changed), not O(history)).
        let prev = out.view_version;
        let out2 = node
            .ingest_and_materialize(
                &co_id,
                session,
                None,
                &trusting_chunk("b", serde_json::json!(2), 1_700_000_000_001),
                "sig",
                true,
                prev,
                &[],
            )
            .unwrap();
        assert_eq!(out2.count, 2);
        assert!(out2.view_version > prev, "version bumps on the second ingest");
        let delta2: serde_json::Value = serde_json::from_str(&out2.delta_json).unwrap();
        assert_eq!(delta2["reset"], serde_json::json!(false), "caught-up cursor patches");
        let changed2 = delta2["changedKeys"].as_object().unwrap();
        assert_eq!(changed2.len(), 1, "delta since prev carries only the new key");
        let b_ops = delta2["changedKeys"]["b"].as_array().unwrap();
        assert_eq!(b_ops[0]["change"], serde_json::json!({"op":"set","key":"b","value":2}));

        // The materialized view is identical to what the separate
        // add+materialize path would produce.
        assert_eq!(node.map_get(&co_id, "a").unwrap(), Some("1".to_string()));
        assert_eq!(node.map_get(&co_id, "b").unwrap(), Some("2".to_string()));
        let snap: serde_json::Value =
            serde_json::from_str(&node.map_snapshot(&co_id).unwrap()).unwrap();
        assert_eq!(snap, serde_json::json!({"a": 1, "b": 2}));
    }

    #[test]
    fn ingest_and_materialize_unknown_covalue_errors() {
        let mut node = NodeCore::new();
        match node.ingest_and_materialize(
            "co_zNope",
            "co_zNope_session_zS",
            None,
            &trusting_chunk("a", serde_json::json!(1), 1_700_000_000_000),
            "sig",
            true,
            0,
            &[],
        ) {
            Err(SessionMapError::UnknownCoValue(id)) => assert_eq!(id, "co_zNope"),
            other => panic!("expected UnknownCoValue, got {other:?}"),
        }
    }

    #[test]
    fn invalid_header_does_not_insert() {
        let mut node = NodeCore::new();
        assert!(node
            .create_co_value("co_zBogus", "{not json", None, false)
            .is_err());
        assert!(!node.has_co_value("co_zBogus"));
    }
}
