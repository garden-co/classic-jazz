use crate::session_map::{KnownState, SessionMapError};
use cojson_core::core::{
    IngestOutcome as RustIngestOutcome, NodeCore as RustNodeCore, PendingTxIn as RustPendingTxIn,
    Verdict as RustVerdict, VerdictDelta as RustVerdictDelta,
};
use std::sync::Mutex;

// ============================================================================
// NodeCore - uniffi wrapper for the node-level CoValue registry
// ============================================================================

/// A merged transaction's source identity, mirroring the `(session_id,
/// tx_index)` tuple carried by `PendingTxIn::source_tx_id` on the Rust side.
/// Plain camelCase on the generated TS side (uniffi lower-cases record field
/// names the same way napi objects do) — unlike the JSON wire format used
/// elsewhere in this codebase (`TransactionID`'s `sessionID`), uniffi records
/// bypass serde entirely, so there is no `#[serde(rename)]` to apply here.
/// The TS adapter (added in a later task) is responsible for bridging its
/// `sessionID`-cased public type to this `sessionId`-cased record.
#[derive(uniffi::Record, Clone, Debug)]
pub struct SourceTxId {
    pub session_id: String,
    pub tx_index: u32,
}

/// A pending (not-yet-persisted) transaction handed to `validate_transactions`,
/// mirroring `PendingTxIn` on the Rust side.
#[derive(uniffi::Record, Clone, Debug)]
pub struct PendingTx {
    pub session_id: String,
    pub tx_index: u32,
    pub source_made_at: Option<f64>,
    pub meta_json: Option<String>,
    pub source_tx_id: Option<SourceTxId>,
}

/// Validation verdict for a single transaction, mirroring `Verdict` on the
/// Rust side.
#[derive(uniffi::Record, Clone, Debug)]
pub struct GroupVerdict {
    pub session_id: String,
    pub tx_index: u32,
    pub valid: bool,
    /// One of "valid" / "invalid" / "validBranchPointerOnly", mirroring
    /// `VerdictOutcome` on the Rust side.
    pub outcome: String,
    pub reason: Option<String>,
}

/// Mirrors the napi binding's `verdict_outcome_to_str` / the wasm binding's
/// `impl From<RustVerdict> for GroupVerdictWire` — a reviewer designated the
/// wasm `From` idiom the cleaner target of the two, so this binding follows
/// it rather than a free helper fn.
impl From<RustVerdict> for GroupVerdict {
    fn from(v: RustVerdict) -> Self {
        GroupVerdict {
            session_id: v.session_id,
            tx_index: v.tx_index,
            valid: v.valid,
            outcome: v.outcome.as_str().to_string(),
            reason: v.reason,
        }
    }
}

/// A DELTA of validation verdicts, mirroring `VerdictDelta` on the Rust side:
/// the verdicts the caller has not yet seen, tagged with the engine `generation`
/// and the `from_index` where they begin in the full list. `generation` is an
/// `f64` for lossless JS-number round-tripping of the u64 counter.
#[derive(uniffi::Record, Clone, Debug)]
pub struct VerdictDelta {
    pub generation: f64,
    pub from_index: u32,
    pub verdicts: Vec<GroupVerdict>,
}

impl From<RustVerdictDelta> for VerdictDelta {
    fn from(d: RustVerdictDelta) -> Self {
        VerdictDelta {
            generation: d.generation as f64,
            from_index: d.from_index,
            verdicts: d.verdicts.into_iter().map(GroupVerdict::from).collect(),
        }
    }
}

/// The compact result of the R3 stage-1 single-call ingest, mirroring
/// `IngestOutcome` on the Rust side: `{generation, count, viewVersion,
/// deltaJson}`, with no per-transaction verdict array (validation happens
/// in-crate). `generation`/`viewVersion` are `f64` for lossless JS-number
/// round-tripping of the u64 counters.
#[derive(uniffi::Record, Clone, Debug)]
pub struct IngestOutcome {
    pub generation: f64,
    pub count: u32,
    pub view_version: f64,
    pub delta_json: String,
}

impl From<RustIngestOutcome> for IngestOutcome {
    fn from(o: RustIngestOutcome) -> Self {
        IngestOutcome {
            generation: o.generation as f64,
            count: o.count,
            view_version: o.view_version as f64,
            delta_json: o.delta_json,
        }
    }
}

fn rn_pending_to_rust(pending: Vec<PendingTx>) -> Vec<RustPendingTxIn> {
    pending
        .into_iter()
        .map(|p| RustPendingTxIn {
            session_id: p.session_id,
            tx_index: p.tx_index,
            source_made_at: p.source_made_at.map(|v| v as u64),
            meta_json: p.meta_json,
            source_tx_id: p.source_tx_id.map(|s| (s.session_id, s.tx_index)),
        })
        .collect()
}

#[derive(uniffi::Object)]
pub struct NodeCore {
    internal: Mutex<RustNodeCore>,
}

// NOTE: a parallel copy of every method body in `impl SessionMap` (session_map.rs)
// lives here (co_id-first). When editing a lifted method in `impl SessionMap`,
// update its NodeCore twin too — and vice versa: this comment is the other
// half of the "parallel copy" breadcrumb at the top of `impl SessionMap` in
// that file.
#[uniffi::export]
impl NodeCore {
    /// Create a new empty NodeCore registry (one LocalNode owns one instance).
    #[uniffi::constructor]
    #[allow(clippy::new_without_default)]
    pub fn new() -> Self {
        NodeCore {
            internal: Mutex::new(RustNodeCore::new()),
        }
    }

    // === Registry ===

    /// Creates or replaces; replacing drops the previous session state.
    /// Mirrors TS semantics where constructing a new VerifiedState for an
    /// already-known id creates a fresh SessionMap.
    pub fn create_co_value(
        &self,
        co_id: String,
        header_json: String,
        max_tx_size: Option<u32>,
        skip_verify: Option<bool>,
    ) -> Result<(), SessionMapError> {
        let mut internal = self
            .internal
            .lock()
            .map_err(|_| SessionMapError::LockError)?;
        internal
            .create_co_value(
                &co_id,
                &header_json,
                max_tx_size,
                skip_verify.unwrap_or(false),
            )
            .map_err(|e| SessionMapError::Internal(e.to_string()))
    }

    pub fn has_co_value(&self, co_id: String) -> Result<bool, SessionMapError> {
        let internal = self
            .internal
            .lock()
            .map_err(|_| SessionMapError::LockError)?;
        Ok(internal.has_co_value(&co_id))
    }

    pub fn remove_co_value(&self, co_id: String) -> Result<bool, SessionMapError> {
        let mut internal = self
            .internal
            .lock()
            .map_err(|_| SessionMapError::LockError)?;
        Ok(internal.remove_co_value(&co_id))
    }

    pub fn co_value_count(&self) -> Result<u32, SessionMapError> {
        let internal = self
            .internal
            .lock()
            .map_err(|_| SessionMapError::LockError)?;
        Ok(internal.co_value_count() as u32)
    }

    // === Lifted SessionMap surface ===
    // Each method prepends `co_id: String` and resolves the entry via
    // get()/get_mut() before delegating, mapping UnknownCoValue through
    // SessionMapError::Internal. Method bodies are lifted verbatim from
    // impl SessionMap so every conversion (JSON strings, KnownState::from,
    // -1 conventions, Option -> None) is preserved.

    // --- Header ---

    /// Get the header as JSON
    pub fn get_header(&self, co_id: String) -> Result<String, SessionMapError> {
        let internal = self
            .internal
            .lock()
            .map_err(|_| SessionMapError::LockError)?;
        Ok(internal
            .get(&co_id)
            .map_err(|e| SessionMapError::Internal(e.to_string()))?
            .get_header())
    }

    // --- Transaction Operations ---

    /// Add transactions to a session
    pub fn add_transactions(
        &self,
        co_id: String,
        session_id: String,
        signer_id: Option<String>,
        transactions_json: String,
        signature: String,
        skip_verify: bool,
    ) -> Result<(), SessionMapError> {
        let mut internal = self
            .internal
            .lock()
            .map_err(|_| SessionMapError::LockError)?;
        internal
            .get_mut(&co_id)
            .map_err(|e| SessionMapError::Internal(e.to_string()))?
            .add_transactions(
                &session_id,
                signer_id.as_deref(),
                &transactions_json,
                &signature,
                skip_verify,
            )
            .map_err(|e| SessionMapError::Internal(e.to_string()))
    }

    /// Create new private transaction (for local writes)
    /// Returns JSON: { signature: string, transaction: Transaction }
    #[allow(clippy::too_many_arguments)]
    pub fn make_new_private_transaction(
        &self,
        co_id: String,
        session_id: String,
        signer_secret: String,
        changes_json: String,
        key_id: String,
        key_secret: String,
        meta_json: Option<String>,
        made_at: f64,
    ) -> Result<String, SessionMapError> {
        let mut internal = self
            .internal
            .lock()
            .map_err(|_| SessionMapError::LockError)?;
        let signed_tx = internal
            .get_mut(&co_id)
            .map_err(|e| SessionMapError::Internal(e.to_string()))?
            .make_new_private_transaction(
                session_id,
                signer_secret,
                &changes_json,
                key_id,
                key_secret,
                meta_json,
                made_at as u64,
            )
            .map_err(|e| SessionMapError::Internal(e.to_string()))?;

        let tx_json = serde_json::to_string(&signed_tx.transaction)
            .map_err(|e| SessionMapError::Internal(e.to_string()))?;
        Ok(format!(
            r#"{{"signature":"{}","transaction":{}}}"#,
            signed_tx.signature.0, tx_json
        ))
    }

    /// Create new trusting transaction (for local writes)
    /// Returns JSON: { signature: string, transaction: Transaction }
    pub fn make_new_trusting_transaction(
        &self,
        co_id: String,
        session_id: String,
        signer_secret: String,
        changes_json: String,
        meta_json: Option<String>,
        made_at: f64,
    ) -> Result<String, SessionMapError> {
        let mut internal = self
            .internal
            .lock()
            .map_err(|_| SessionMapError::LockError)?;
        let signed_tx = internal
            .get_mut(&co_id)
            .map_err(|e| SessionMapError::Internal(e.to_string()))?
            .make_new_trusting_transaction(
                session_id,
                signer_secret,
                &changes_json,
                meta_json,
                made_at as u64,
            )
            .map_err(|e| SessionMapError::Internal(e.to_string()))?;

        let tx_json = serde_json::to_string(&signed_tx.transaction)
            .map_err(|e| SessionMapError::Internal(e.to_string()))?;
        Ok(format!(
            r#"{{"signature":"{}","transaction":{}}}"#,
            signed_tx.signature.0, tx_json
        ))
    }

    // --- Session Queries ---

    /// Get all session IDs as native array
    pub fn get_session_ids(&self, co_id: String) -> Result<Vec<String>, SessionMapError> {
        let internal = self
            .internal
            .lock()
            .map_err(|_| SessionMapError::LockError)?;
        Ok(internal
            .get(&co_id)
            .map_err(|e| SessionMapError::Internal(e.to_string()))?
            .get_session_ids())
    }

    /// Get transaction count for a session (returns -1 if session not found)
    pub fn get_transaction_count(
        &self,
        co_id: String,
        session_id: String,
    ) -> Result<i32, SessionMapError> {
        let internal = self
            .internal
            .lock()
            .map_err(|_| SessionMapError::LockError)?;
        let sm = internal
            .get(&co_id)
            .map_err(|e| SessionMapError::Internal(e.to_string()))?;
        // Same -1-if-absent convention as the SessionMap wrapper
        Ok(sm
            .get_transaction_count(&session_id)
            .map(|c| c as i32)
            .unwrap_or(-1))
    }

    /// Get single transaction by index as JSON string (returns None if not found)
    pub fn get_transaction(
        &self,
        co_id: String,
        session_id: String,
        tx_index: u32,
    ) -> Result<Option<String>, SessionMapError> {
        let internal = self
            .internal
            .lock()
            .map_err(|_| SessionMapError::LockError)?;
        Ok(internal
            .get(&co_id)
            .map_err(|e| SessionMapError::Internal(e.to_string()))?
            .get_transaction(&session_id, tx_index))
    }

    /// Get transactions for a session from index as JSON strings (returns None if session not found)
    pub fn get_session_transactions(
        &self,
        co_id: String,
        session_id: String,
        from_index: u32,
    ) -> Result<Option<Vec<String>>, SessionMapError> {
        let internal = self
            .internal
            .lock()
            .map_err(|_| SessionMapError::LockError)?;
        Ok(internal
            .get(&co_id)
            .map_err(|e| SessionMapError::Internal(e.to_string()))?
            .get_session_transactions(&session_id, from_index))
    }

    /// Get last signature for a session (returns None if session not found)
    pub fn get_last_signature(
        &self,
        co_id: String,
        session_id: String,
    ) -> Result<Option<String>, SessionMapError> {
        let internal = self
            .internal
            .lock()
            .map_err(|_| SessionMapError::LockError)?;
        Ok(internal
            .get(&co_id)
            .map_err(|e| SessionMapError::Internal(e.to_string()))?
            .get_last_signature(&session_id))
    }

    /// Get signature after specific transaction index
    pub fn get_signature_after(
        &self,
        co_id: String,
        session_id: String,
        tx_index: u32,
    ) -> Result<Option<String>, SessionMapError> {
        let internal = self
            .internal
            .lock()
            .map_err(|_| SessionMapError::LockError)?;
        Ok(internal
            .get(&co_id)
            .map_err(|e| SessionMapError::Internal(e.to_string()))?
            .get_signature_after(&session_id, tx_index))
    }

    /// Get the last signature checkpoint index (-1 if no checkpoints, None if session not found)
    pub fn get_last_signature_checkpoint(
        &self,
        co_id: String,
        session_id: String,
    ) -> Result<Option<i32>, SessionMapError> {
        let internal = self
            .internal
            .lock()
            .map_err(|_| SessionMapError::LockError)?;
        Ok(internal
            .get(&co_id)
            .map_err(|e| SessionMapError::Internal(e.to_string()))?
            .get_last_signature_checkpoint(&session_id))
    }

    // --- Known State ---

    /// Get the known state as a native Record
    pub fn get_known_state(&self, co_id: String) -> Result<KnownState, SessionMapError> {
        let internal = self
            .internal
            .lock()
            .map_err(|_| SessionMapError::LockError)?;
        Ok(internal
            .get(&co_id)
            .map_err(|e| SessionMapError::Internal(e.to_string()))?
            .get_known_state()
            .into())
    }

    /// Get the known state with streaming as a native Record
    pub fn get_known_state_with_streaming(
        &self,
        co_id: String,
    ) -> Result<Option<KnownState>, SessionMapError> {
        let internal = self
            .internal
            .lock()
            .map_err(|_| SessionMapError::LockError)?;
        Ok(internal
            .get(&co_id)
            .map_err(|e| SessionMapError::Internal(e.to_string()))?
            .get_known_state_with_streaming()
            .map(|ks| ks.into()))
    }

    /// Check whether the CoValue still has pending streaming content.
    pub fn is_streaming(&self, co_id: String) -> Result<bool, SessionMapError> {
        let internal = self
            .internal
            .lock()
            .map_err(|_| SessionMapError::LockError)?;
        Ok(internal
            .get(&co_id)
            .map_err(|e| SessionMapError::Internal(e.to_string()))?
            .is_streaming())
    }

    /// Set streaming known state
    pub fn set_streaming_known_state(
        &self,
        co_id: String,
        streaming_json: String,
    ) -> Result<(), SessionMapError> {
        let mut internal = self
            .internal
            .lock()
            .map_err(|_| SessionMapError::LockError)?;
        internal
            .get_mut(&co_id)
            .map_err(|e| SessionMapError::Internal(e.to_string()))?
            .set_streaming_known_state(&streaming_json)
            .map_err(|e| SessionMapError::Internal(e.to_string()))
    }

    // --- Deletion ---

    /// Mark this CoValue as deleted
    pub fn mark_as_deleted(&self, co_id: String) -> Result<(), SessionMapError> {
        let mut internal = self
            .internal
            .lock()
            .map_err(|_| SessionMapError::LockError)?;
        internal
            .get_mut(&co_id)
            .map_err(|e| SessionMapError::Internal(e.to_string()))?
            .mark_as_deleted();
        Ok(())
    }

    /// Check if this CoValue is deleted
    pub fn is_deleted(&self, co_id: String) -> Result<bool, SessionMapError> {
        let internal = self
            .internal
            .lock()
            .map_err(|_| SessionMapError::LockError)?;
        Ok(internal
            .get(&co_id)
            .map_err(|e| SessionMapError::Internal(e.to_string()))?
            .is_deleted())
    }

    // --- Decryption ---

    /// Decrypt transaction changes
    pub fn decrypt_transaction(
        &self,
        co_id: String,
        session_id: String,
        tx_index: u32,
        key_secret: String,
    ) -> Result<Option<String>, SessionMapError> {
        let internal = self
            .internal
            .lock()
            .map_err(|_| SessionMapError::LockError)?;
        internal
            .get(&co_id)
            .map_err(|e| SessionMapError::Internal(e.to_string()))?
            .decrypt_transaction(&session_id, tx_index, &key_secret)
            .map_err(|e| SessionMapError::Internal(e.to_string()))
    }

    /// Decrypt transaction meta
    pub fn decrypt_transaction_meta(
        &self,
        co_id: String,
        session_id: String,
        tx_index: u32,
        key_secret: String,
    ) -> Result<Option<String>, SessionMapError> {
        let internal = self
            .internal
            .lock()
            .map_err(|_| SessionMapError::LockError)?;
        internal
            .get(&co_id)
            .map_err(|e| SessionMapError::Internal(e.to_string()))?
            .decrypt_transaction_meta(&session_id, tx_index, &key_secret)
            .map_err(|e| SessionMapError::Internal(e.to_string()))
    }

    // === Stage 2/3: Group engine surface ===
    // These methods are NodeCore-ONLY — there is no SessionMap twin (the
    // group engine is inherently cross-CoValue, so it can't live on a single
    // SessionMap). Do not go looking for a `parallel copy` in `impl SessionMap`
    // above; the "lifted verbatim" breadcrumb on that section doesn't apply
    // here.

    /// Validate a group/account CoValue; verdicts for ALL its transactions in
    /// validation order.
    /// Throws "Unknown CoValue: <id>" if `co_id` itself is not registered, and
    /// "CoValue not loaded: <id>" if a dependency (parent group / owning
    /// account) is missing.
    pub fn validate_transactions(
        &self,
        co_id: String,
        pending: Vec<PendingTx>,
    ) -> Result<Vec<GroupVerdict>, SessionMapError> {
        let pending = rn_pending_to_rust(pending);
        let mut internal = self
            .internal
            .lock()
            .map_err(|_| SessionMapError::LockError)?;
        let verdicts = internal
            .validate_transactions(&co_id, &pending)
            .map_err(|e| SessionMapError::Internal(e.to_string()))?;
        Ok(verdicts.into_iter().map(GroupVerdict::from).collect())
    }

    /// Delta counterpart of `validate_transactions`: given the caller's
    /// `(since_generation, since_count)` cursor, return only the verdicts it has
    /// not seen. On a generation match returns `verdicts[since_count..]` with
    /// `from_index = since_count`; on a mismatch returns the whole list with
    /// `from_index = 0`. Same error contract as `validate_transactions`.
    pub fn validate_transactions_delta(
        &self,
        co_id: String,
        since_generation: f64,
        since_count: u32,
        pending: Vec<PendingTx>,
    ) -> Result<VerdictDelta, SessionMapError> {
        let pending = rn_pending_to_rust(pending);
        let mut internal = self
            .internal
            .lock()
            .map_err(|_| SessionMapError::LockError)?;
        let delta = internal
            .validate_transactions_delta(&co_id, since_generation as u64, since_count, &pending)
            .map_err(|e| SessionMapError::Internal(e.to_string()))?;
        Ok(VerdictDelta::from(delta))
    }

    /// R3 stage-1 single-call ingest: add a content chunk's transactions, validate
    /// them in-crate, and materialize the coMap view in ONE crossing — returning
    /// only the compact `IngestOutcome` (no per-transaction verdict array). The raw
    /// session log is still written, so the TS sync/storage paths are unaffected.
    /// See `NodeCore::ingest_and_materialize`.
    #[allow(clippy::too_many_arguments)]
    pub fn ingest_and_materialize(
        &self,
        co_id: String,
        session_id: String,
        signer_id: Option<String>,
        transactions_json: String,
        signature: String,
        skip_verify: bool,
        since_version: f64,
        pending: Vec<PendingTx>,
    ) -> Result<IngestOutcome, SessionMapError> {
        let pending = rn_pending_to_rust(pending);
        let mut internal = self
            .internal
            .lock()
            .map_err(|_| SessionMapError::LockError)?;
        let out = internal
            .ingest_and_materialize(
                &co_id,
                &session_id,
                signer_id.as_deref(),
                &transactions_json,
                &signature,
                skip_verify,
                since_version as u64,
                &pending,
            )
            .map_err(|e| SessionMapError::Internal(e.to_string()))?;
        Ok(IngestOutcome::from(out))
    }

    // === R0/R3 coMap materialization (previously absent on RN) ===

    /// Materialize (or incrementally refresh) `co_id`'s coMap view; returns its
    /// current monotonic version. Call after each ingest batch.
    pub fn map_materialize(
        &self,
        co_id: String,
        pending: Vec<PendingTx>,
    ) -> Result<f64, SessionMapError> {
        let pending = rn_pending_to_rust(pending);
        let mut internal = self
            .internal
            .lock()
            .map_err(|_| SessionMapError::LockError)?;
        internal
            .map_materialize(&co_id, &pending)
            .map(|v| v as f64)
            .map_err(|e| SessionMapError::Internal(e.to_string()))
    }

    /// Boundary (a): latest JSON value for `key`, or null.
    pub fn map_get(&self, co_id: String, key: String) -> Result<Option<String>, SessionMapError> {
        let internal = self
            .internal
            .lock()
            .map_err(|_| SessionMapError::LockError)?;
        internal
            .map_get(&co_id, &key)
            .map_err(|e| SessionMapError::Internal(e.to_string()))
    }

    /// Boundary (a): JSON value for `key` at `at_time` (ms; omit for latest).
    pub fn map_get_at(
        &self,
        co_id: String,
        key: String,
        at_time: Option<f64>,
    ) -> Result<Option<String>, SessionMapError> {
        let internal = self
            .internal
            .lock()
            .map_err(|_| SessionMapError::LockError)?;
        internal
            .map_get_at(&co_id, &key, at_time.map(|v| v as u64))
            .map_err(|e| SessionMapError::Internal(e.to_string()))
    }

    /// Boundary (b): whole materialized map as a JSON object string.
    pub fn map_snapshot(&self, co_id: String) -> Result<String, SessionMapError> {
        let internal = self
            .internal
            .lock()
            .map_err(|_| SessionMapError::LockError)?;
        internal
            .map_snapshot(&co_id)
            .map_err(|e| SessionMapError::Internal(e.to_string()))
    }

    /// Boundary (c): `{version, changedKeys, deletedKeys}` since `since_version`.
    pub fn map_delta(&self, co_id: String, since_version: f64) -> Result<String, SessionMapError> {
        let internal = self
            .internal
            .lock()
            .map_err(|_| SessionMapError::LockError)?;
        internal
            .map_delta(&co_id, since_version as u64)
            .map_err(|e| SessionMapError::Internal(e.to_string()))
    }

    /// Boundary (c-rich): `{version, reset, changedKeys}` since `since_version`,
    /// each `changedKeys[k]` the full `MapOp[]` op-list — the payload a TS
    /// `RawCoMap` rebuilds `ops`/`latest` from.
    pub fn map_delta_rich(
        &self,
        co_id: String,
        since_version: f64,
    ) -> Result<String, SessionMapError> {
        let internal = self
            .internal
            .lock()
            .map_err(|_| SessionMapError::LockError)?;
        internal
            .map_delta_rich(&co_id, since_version as u64)
            .map_err(|e| SessionMapError::Internal(e.to_string()))
    }

    /// Frontier read: latest frontier-visible value of `key` (null = absent).
    /// `frontier_json` is `{ sessionID: txCount }`.
    pub fn map_get_at_frontier(
        &self,
        co_id: String,
        key: String,
        frontier_json: String,
    ) -> Result<Option<String>, SessionMapError> {
        let internal = self
            .internal
            .lock()
            .map_err(|_| SessionMapError::LockError)?;
        internal
            .map_get_at_frontier(&co_id, &key, &frontier_json)
            .map_err(|e| SessionMapError::Internal(e.to_string()))
    }

    /// Frontier read: whole `{key: latestVisibleValue}` snapshot under
    /// `frontier_json` as a JSON object string.
    pub fn map_snapshot_at_frontier(
        &self,
        co_id: String,
        frontier_json: String,
    ) -> Result<String, SessionMapError> {
        let internal = self
            .internal
            .lock()
            .map_err(|_| SessionMapError::LockError)?;
        internal
            .map_snapshot_at_frontier(&co_id, &frontier_json)
            .map_err(|e| SessionMapError::Internal(e.to_string()))
    }

    /// Drop the cached validation engine for `co_id`, forcing a full recompute
    /// on the next `validate_transactions` / `role_of`. An absent `co_id` is a
    /// no-op (not `UnknownCoValue`): callers invoke this on dependants that may
    /// never have been registered on this node, so erroring would be hostile.
    pub fn reset_validation(&self, co_id: String) -> Result<(), SessionMapError> {
        let mut internal = self
            .internal
            .lock()
            .map_err(|_| SessionMapError::LockError)?;
        internal.reset_validation(&co_id);
        Ok(())
    }

    // === R1 key store (experimental) ===

    /// Feed a resolved `KeyID -> KeySecret` to the native key store (idempotent).
    /// Native private-tx materialization is the only consumer; secrets never
    /// leave Rust once provided.
    pub fn provide_key_secret(
        &self,
        key_id: String,
        key_secret: String,
    ) -> Result<(), SessionMapError> {
        let mut internal = self
            .internal
            .lock()
            .map_err(|_| SessionMapError::LockError)?;
        internal.provide_key_secret(&key_id, &key_secret);
        Ok(())
    }

    /// Whether a secret for `key_id` has been provided.
    pub fn has_key_secret(&self, key_id: String) -> Result<bool, SessionMapError> {
        let internal = self
            .internal
            .lock()
            .map_err(|_| SessionMapError::LockError)?;
        Ok(internal.has_key_secret(&key_id))
    }

    /// The `KeyID`s `co_id`'s materialized view still needs a secret for.
    pub fn missing_key_ids(&self, co_id: String) -> Result<Vec<String>, SessionMapError> {
        let internal = self
            .internal
            .lock()
            .map_err(|_| SessionMapError::LockError)?;
        Ok(internal.missing_key_ids(&co_id))
    }

    /// Role of member in group at time (ms). Returns the role string or None.
    /// Throws "Unknown CoValue: <id>" if `group_id` itself is not registered,
    /// and "CoValue not loaded: <id>" if a parent group / owning account is
    /// missing.
    pub fn role_of(
        &self,
        group_id: String,
        member: String,
        at_time: Option<f64>,
    ) -> Result<Option<String>, SessionMapError> {
        let mut internal = self
            .internal
            .lock()
            .map_err(|_| SessionMapError::LockError)?;
        let role = internal
            .role_of(&group_id, &member, at_time.map(|v| v as u64))
            .map_err(|e| SessionMapError::Internal(e.to_string()))?;
        Ok(role.map(|r| r.as_str().to_string()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // Build a valid header + matching co_id, mirroring
    // `crates/cojson-core/src/core/node.rs`'s own test helper.
    fn valid_header() -> (String, String) {
        use cojson_core::core::{CoValueHeader, NullableString, RulesetDef, Uniqueness};

        let header = CoValueHeader {
            created_at: NullableString::Missing,
            meta: None,
            ruleset: RulesetDef::unsafe_allow_all(),
            co_type: "comap".to_string(),
            uniqueness: Uniqueness::String("test".to_string()),
        };
        let header_json = serde_json::to_string(&header).unwrap();
        let co_id =
            cojson_core::hash::blake3::short_hash_with_prefix(header_json.as_bytes(), "co_z");
        (co_id, header_json)
    }

    #[test]
    fn create_has_remove_roundtrip() {
        let (co_id, header_json) = valid_header();
        let node = NodeCore::new();
        assert!(!node.has_co_value(co_id.clone()).unwrap());
        assert_eq!(node.co_value_count().unwrap(), 0);

        node.create_co_value(co_id.clone(), header_json, None, None)
            .unwrap();
        assert!(node.has_co_value(co_id.clone()).unwrap());
        assert_eq!(node.co_value_count().unwrap(), 1);

        assert!(node.remove_co_value(co_id.clone()).unwrap());
        assert!(!node.has_co_value(co_id).unwrap());
        assert_eq!(node.co_value_count().unwrap(), 0);
    }

    #[test]
    fn remove_absent_is_noop() {
        let node = NodeCore::new();
        assert!(!node
            .remove_co_value("co_zDoesNotExist".to_string())
            .unwrap());
    }

    #[test]
    fn unknown_co_value_error_preserves_prefix() {
        let node = NodeCore::new();
        let err = node.get_header("co_zDoesNotExist".to_string()).unwrap_err();
        // Load-bearing: TS-side error translation does
        // `message.startsWith("Unknown CoValue: ")` / `"CoValue not loaded: "`.
        // If SessionMapError::Internal's Display ever re-adds a wrapping
        // prefix, this assertion catches the regression.
        assert_eq!(err.to_string(), "Unknown CoValue: co_zDoesNotExist");
    }

    #[test]
    fn reset_validation_on_absent_id_is_noop() {
        let node = NodeCore::new();
        assert!(node
            .reset_validation("co_zDoesNotExist".to_string())
            .is_ok());
    }

    #[test]
    fn role_of_unknown_group_errors_with_prefix() {
        let node = NodeCore::new();
        let err = node
            .role_of(
                "co_zDoesNotExist".to_string(),
                "co_zMember".to_string(),
                None,
            )
            .unwrap_err();
        assert_eq!(err.to_string(), "Unknown CoValue: co_zDoesNotExist");
    }
}
