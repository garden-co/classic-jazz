use cojson_core::core::{
  CoJsonCoreError, IngestOutcome as RustIngestOutcome, KnownState as RustKnownState,
  NodeCore as RustNodeCore, PendingTxIn as RustPendingTxIn, SessionMapImpl, Verdict as RustVerdict,
  VerdictDelta as RustVerdictDelta, VerdictOutcome as RustVerdictOutcome,
};
use napi_derive::napi;
use std::collections::HashMap;
use thiserror::Error;

// ============================================================================
// KnownState - Native JavaScript Object
// ============================================================================

/// KnownState as a native JavaScript object (no JSON serialization needed)
#[napi(object)]
#[derive(Clone, Debug)]
pub struct KnownState {
  pub id: String,
  pub header: bool,
  pub sessions: HashMap<String, u32>,
}

impl From<RustKnownState> for KnownState {
  fn from(ks: RustKnownState) -> Self {
    KnownState {
      id: ks.id,
      header: ks.header,
      sessions: ks.sessions.into_iter().collect(),
    }
  }
}

pub mod hash {
  pub mod blake3;
  pub use blake3::*;
}

pub mod crypto {
  pub mod ed25519;
  pub mod encrypt;
  pub mod seal;
  pub mod signature;
  pub mod x25519;
  pub mod xsalsa20;

  pub use ed25519::*;
  pub use encrypt::*;
  pub use seal::*;
  pub use signature::*;
  pub use x25519::*;
  pub use xsalsa20::*;
}

#[derive(Error, Debug)]
pub enum CojsonCoreError {
  #[error(transparent)]
  CoJson(#[from] CoJsonCoreError),
  #[error(transparent)]
  Serde(#[from] serde_json::Error),
  #[error("String Error: {0:?}")]
  Js(String),
}

impl From<CojsonCoreError> for String {
  fn from(err: CojsonCoreError) -> Self {
    err.to_string()
  }
}

// ============================================================================
// SessionMap - NAPI wrapper for SessionMapImpl
// ============================================================================

#[napi]
pub struct SessionMap {
  internal: SessionMapImpl,
}

// NOTE: a parallel copy of every method body below lives in `impl NodeCore`
// (co_id-first). When editing a method here, update its NodeCore twin too.
#[napi]
impl SessionMap {
  /// Create a new SessionMap for a CoValue.
  /// Validates the header and verifies that `co_id` matches the hash of the header.
  /// `max_tx_size` is the threshold for recording in-between signatures (default: 100KB)
  /// `skip_verify` if true, skips uniqueness and ID validation (for trusted storage shards)
  #[napi(constructor)]
  pub fn new(
    co_id: String,
    header_json: String,
    max_tx_size: Option<u32>,
    skip_verify: Option<bool>,
  ) -> napi::Result<SessionMap> {
    let internal = SessionMapImpl::new_with_skip_verify(
      &co_id,
      &header_json,
      max_tx_size,
      skip_verify.unwrap_or(false),
    )
    .map_err(|e| napi::Error::new(napi::Status::GenericFailure, e.to_string()))?;
    Ok(SessionMap { internal })
  }

  // === Header ===

  /// Get the header as JSON
  #[napi]
  pub fn get_header(&self) -> String {
    self.internal.get_header()
  }

  // === Transaction Operations ===

  /// Add transactions to a session
  #[napi]
  pub fn add_transactions(
    &mut self,
    session_id: String,
    signer_id: Option<String>,
    transactions_json: String,
    signature: String,
    skip_verify: bool,
  ) -> napi::Result<()> {
    self
      .internal
      .add_transactions(
        &session_id,
        signer_id.as_deref(),
        &transactions_json,
        &signature,
        skip_verify,
      )
      .map_err(|e| napi::Error::new(napi::Status::GenericFailure, e.to_string()))
  }

  /// Create new private transaction (for local writes)
  /// Returns JSON: { signature: string, transaction: Transaction }
  #[napi]
  #[allow(clippy::too_many_arguments)]
  pub fn make_new_private_transaction(
    &mut self,
    session_id: String,
    signer_secret: String,
    changes_json: String,
    key_id: String,
    key_secret: String,
    meta_json: Option<String>,
    made_at: f64,
  ) -> napi::Result<String> {
    let signed_tx = self
      .internal
      .make_new_private_transaction(
        session_id,
        signer_secret,
        &changes_json,
        key_id,
        key_secret,
        meta_json,
        made_at as u64,
      )
      .map_err(|e| napi::Error::new(napi::Status::GenericFailure, e.to_string()))?;

    let tx_json = serde_json::to_string(&signed_tx.transaction)
      .map_err(|e| napi::Error::new(napi::Status::GenericFailure, e.to_string()))?;
    Ok(format!(
      r#"{{"signature":"{}","transaction":{}}}"#,
      signed_tx.signature.0, tx_json
    ))
  }

  /// Create new trusting transaction (for local writes)
  /// Returns JSON: { signature: string, transaction: Transaction }
  #[napi]
  pub fn make_new_trusting_transaction(
    &mut self,
    session_id: String,
    signer_secret: String,
    changes_json: String,
    meta_json: Option<String>,
    made_at: f64,
  ) -> napi::Result<String> {
    let signed_tx = self
      .internal
      .make_new_trusting_transaction(
        session_id,
        signer_secret,
        &changes_json,
        meta_json,
        made_at as u64,
      )
      .map_err(|e| napi::Error::new(napi::Status::GenericFailure, e.to_string()))?;

    let tx_json = serde_json::to_string(&signed_tx.transaction)
      .map_err(|e| napi::Error::new(napi::Status::GenericFailure, e.to_string()))?;
    Ok(format!(
      r#"{{"signature":"{}","transaction":{}}}"#,
      signed_tx.signature.0, tx_json
    ))
  }

  // === Session Queries ===

  /// Get all session IDs as native array
  #[napi]
  pub fn get_session_ids(&self) -> Vec<String> {
    self.internal.get_session_ids()
  }

  /// Get transaction count for a session (returns -1 if session not found)
  #[napi]
  pub fn get_transaction_count(&self, session_id: String) -> i32 {
    self
      .internal
      .get_transaction_count(&session_id)
      .map(|c| c as i32)
      .unwrap_or(-1)
  }

  /// Get single transaction by index as JSON string (returns undefined if not found)
  #[napi]
  pub fn get_transaction(&self, session_id: String, tx_index: u32) -> Option<String> {
    self.internal.get_transaction(&session_id, tx_index)
  }

  /// Get transactions for a session from index as JSON strings (returns undefined if session not found)
  #[napi]
  pub fn get_session_transactions(
    &self,
    session_id: String,
    from_index: u32,
  ) -> Option<Vec<String>> {
    self
      .internal
      .get_session_transactions(&session_id, from_index)
  }

  /// Get last signature for a session (returns undefined if session not found)
  #[napi]
  pub fn get_last_signature(&self, session_id: String) -> Option<String> {
    self.internal.get_last_signature(&session_id)
  }

  /// Get signature after specific transaction index
  #[napi]
  pub fn get_signature_after(&self, session_id: String, tx_index: u32) -> Option<String> {
    self.internal.get_signature_after(&session_id, tx_index)
  }

  /// Get the last signature checkpoint index (-1 if no checkpoints, undefined if session not found)
  #[napi]
  pub fn get_last_signature_checkpoint(&self, session_id: String) -> Option<i32> {
    self.internal.get_last_signature_checkpoint(&session_id)
  }

  // === Known State ===

  /// Get the known state as a native JavaScript object
  #[napi]
  pub fn get_known_state(&self) -> KnownState {
    self.internal.get_known_state().clone().into()
  }

  /// Get the known state with streaming as a native JavaScript object
  #[napi]
  pub fn get_known_state_with_streaming(&self) -> Option<KnownState> {
    self
      .internal
      .get_known_state_with_streaming()
      .map(|ks| ks.clone().into())
  }

  /// Check whether the CoValue still has pending streaming content.
  #[napi]
  pub fn is_streaming(&self) -> bool {
    self.internal.is_streaming()
  }

  /// Set streaming known state
  #[napi]
  pub fn set_streaming_known_state(&mut self, streaming_json: String) -> napi::Result<()> {
    self
      .internal
      .set_streaming_known_state(&streaming_json)
      .map_err(|e| napi::Error::new(napi::Status::GenericFailure, e.to_string()))
  }

  // === Deletion ===

  /// Mark this CoValue as deleted
  #[napi]
  pub fn mark_as_deleted(&mut self) {
    self.internal.mark_as_deleted();
  }

  /// Check if this CoValue is deleted
  #[napi]
  pub fn is_deleted(&self) -> bool {
    self.internal.is_deleted()
  }

  // === Decryption ===

  /// Decrypt transaction changes
  #[napi]
  pub fn decrypt_transaction(
    &self,
    session_id: String,
    tx_index: u32,
    key_secret: String,
  ) -> napi::Result<Option<String>> {
    self
      .internal
      .decrypt_transaction(&session_id, tx_index, &key_secret)
      .map_err(|e| napi::Error::new(napi::Status::GenericFailure, e.to_string()))
  }

  /// Decrypt transaction meta
  #[napi]
  pub fn decrypt_transaction_meta(
    &self,
    session_id: String,
    tx_index: u32,
    key_secret: String,
  ) -> napi::Result<Option<String>> {
    self
      .internal
      .decrypt_transaction_meta(&session_id, tx_index, &key_secret)
      .map_err(|e| napi::Error::new(napi::Status::GenericFailure, e.to_string()))
  }
}

// ============================================================================
// NodeCore - NAPI wrapper for the node-level CoValue registry
// ============================================================================

/// Map any error implementing Display into a napi::Error (GenericFailure),
/// preserving the message. SessionMapError implements Display, so the
/// registry lookup errors map cleanly.
fn to_napi_err<E: std::fmt::Display>(e: E) -> napi::Error {
  napi::Error::new(napi::Status::GenericFailure, e.to_string())
}

/// A merged transaction's source identity, mirroring the `(session_id,
/// tx_index)` tuple carried by `PendingTxIn::source_tx_id` on the Rust side.
/// napi lower-cases struct field names to plain camelCase (`sessionId`, not
/// `sessionID`) — unlike the JSON wire format elsewhere in this codebase
/// (`TransactionID`'s `sessionID`), napi objects bypass serde entirely, so
/// there is no `#[serde(rename)]` to apply here. The TS adapter is
/// responsible for bridging its `sessionID`-cased public type to this
/// `sessionId`-cased napi object.
#[napi(object)]
pub struct SourceTxId {
  pub session_id: String,
  pub tx_index: u32,
}

/// A pending (not-yet-persisted) transaction handed to `validate_transactions`,
/// mirroring `PendingTxIn` on the Rust side.
#[napi(object)]
pub struct PendingTx {
  pub session_id: String,
  pub tx_index: u32,
  pub source_made_at: Option<f64>,
  pub meta_json: Option<String>,
  pub source_tx_id: Option<SourceTxId>,
}

/// Validation verdict for a single transaction, mirroring `Verdict` on the
/// Rust side.
#[napi(object)]
pub struct GroupVerdict {
  pub session_id: String,
  pub tx_index: u32,
  pub valid: bool,
  /// One of "valid" / "invalid" / "validBranchPointerOnly", mirroring
  /// `VerdictOutcome` on the Rust side.
  pub outcome: String,
  pub reason: Option<String>,
}

fn verdict_outcome_to_str(outcome: RustVerdictOutcome) -> String {
  outcome.as_str().to_string()
}

/// A DELTA of validation verdicts (mirrors `VerdictDelta` on the Rust side): the
/// verdicts the caller has not yet seen, tagged with the engine `generation` and
/// the `from_index` at which they begin in the full list. See
/// `NodeCore::validate_transactions_delta`.
#[napi(object)]
pub struct VerdictDelta {
  pub generation: f64,
  pub from_index: u32,
  pub verdicts: Vec<GroupVerdict>,
}

/// The compact result of `ingestAndMaterialize` (R3 stage-1): the ONLY payload
/// that crosses the boundary per content chunk. Carries no verdict array —
/// validation happens in-crate. Mirrors `IngestOutcome` on the Rust side.
#[napi(object)]
pub struct IngestOutcome {
  /// The validation engine's full-recompute generation after this ingest.
  pub generation: f64,
  /// Total verdict count after this ingest (the TS validation cursor's `count`).
  pub count: u32,
  /// The coMap view's monotonic version after materialization (the delta cursor).
  pub view_version: f64,
  /// `{version, changedKeys, deletedKeys}` since the caller's `sinceVersion`,
  /// as a JSON string.
  pub delta_json: String,
}

fn to_napi_ingest(o: RustIngestOutcome) -> IngestOutcome {
  IngestOutcome {
    generation: o.generation as f64,
    count: o.count,
    view_version: o.view_version as f64,
    delta_json: o.delta_json,
  }
}

fn to_napi_verdict(v: RustVerdict) -> GroupVerdict {
  GroupVerdict {
    session_id: v.session_id,
    tx_index: v.tx_index,
    valid: v.valid,
    outcome: verdict_outcome_to_str(v.outcome),
    reason: v.reason,
  }
}

fn to_napi_delta(d: RustVerdictDelta) -> VerdictDelta {
  VerdictDelta {
    generation: d.generation as f64,
    from_index: d.from_index,
    verdicts: d.verdicts.into_iter().map(to_napi_verdict).collect(),
  }
}

fn to_rust_pending(pending: Vec<PendingTx>) -> Vec<RustPendingTxIn> {
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

#[napi]
pub struct NodeCore {
  internal: RustNodeCore,
}

#[napi]
impl NodeCore {
  /// Create a new empty NodeCore registry (one LocalNode owns one instance).
  #[napi(constructor)]
  #[allow(clippy::new_without_default)]
  pub fn new() -> NodeCore {
    NodeCore {
      internal: RustNodeCore::new(),
    }
  }

  // === Registry ===

  /// Creates or replaces; replacing drops the previous session state.
  /// Mirrors TS semantics where constructing a new VerifiedState for an
  /// already-known id creates a fresh SessionMap.
  #[napi]
  pub fn create_co_value(
    &mut self,
    co_id: String,
    header_json: String,
    max_tx_size: Option<u32>,
    skip_verify: Option<bool>,
  ) -> napi::Result<()> {
    self
      .internal
      .create_co_value(
        &co_id,
        &header_json,
        max_tx_size,
        skip_verify.unwrap_or(false),
      )
      .map_err(to_napi_err)
  }

  #[napi]
  pub fn has_co_value(&self, co_id: String) -> bool {
    self.internal.has_co_value(&co_id)
  }

  #[napi]
  pub fn remove_co_value(&mut self, co_id: String) -> bool {
    self.internal.remove_co_value(&co_id)
  }

  #[napi]
  pub fn co_value_count(&self) -> u32 {
    self.internal.co_value_count() as u32
  }

  // === Lifted SessionMap surface ===
  // Each method prepends `co_id: String` and resolves the entry via
  // get()/get_mut() before delegating, mapping UnknownCoValue through
  // to_napi_err. Method bodies are lifted verbatim from impl SessionMap
  // so every conversion (JSON strings, KnownState::from, -1 conventions,
  // Option -> null) is preserved.

  // --- Header ---

  /// Get the header as JSON
  #[napi]
  pub fn get_header(&self, co_id: String) -> napi::Result<String> {
    Ok(self.internal.get(&co_id).map_err(to_napi_err)?.get_header())
  }

  // --- Transaction Operations ---

  /// Add transactions to a session
  #[napi]
  pub fn add_transactions(
    &mut self,
    co_id: String,
    session_id: String,
    signer_id: Option<String>,
    transactions_json: String,
    signature: String,
    skip_verify: bool,
  ) -> napi::Result<()> {
    self
      .internal
      .get_mut(&co_id)
      .map_err(to_napi_err)?
      .add_transactions(
        &session_id,
        signer_id.as_deref(),
        &transactions_json,
        &signature,
        skip_verify,
      )
      .map_err(to_napi_err)
  }

  /// Create new private transaction (for local writes)
  /// Returns JSON: { signature: string, transaction: Transaction }
  #[napi]
  #[allow(clippy::too_many_arguments)]
  pub fn make_new_private_transaction(
    &mut self,
    co_id: String,
    session_id: String,
    signer_secret: String,
    changes_json: String,
    key_id: String,
    key_secret: String,
    meta_json: Option<String>,
    made_at: f64,
  ) -> napi::Result<String> {
    let signed_tx = self
      .internal
      .get_mut(&co_id)
      .map_err(to_napi_err)?
      .make_new_private_transaction(
        session_id,
        signer_secret,
        &changes_json,
        key_id,
        key_secret,
        meta_json,
        made_at as u64,
      )
      .map_err(to_napi_err)?;

    let tx_json = serde_json::to_string(&signed_tx.transaction).map_err(to_napi_err)?;
    Ok(format!(
      r#"{{"signature":"{}","transaction":{}}}"#,
      signed_tx.signature.0, tx_json
    ))
  }

  /// Create new trusting transaction (for local writes)
  /// Returns JSON: { signature: string, transaction: Transaction }
  #[napi]
  pub fn make_new_trusting_transaction(
    &mut self,
    co_id: String,
    session_id: String,
    signer_secret: String,
    changes_json: String,
    meta_json: Option<String>,
    made_at: f64,
  ) -> napi::Result<String> {
    let signed_tx = self
      .internal
      .get_mut(&co_id)
      .map_err(to_napi_err)?
      .make_new_trusting_transaction(
        session_id,
        signer_secret,
        &changes_json,
        meta_json,
        made_at as u64,
      )
      .map_err(to_napi_err)?;

    let tx_json = serde_json::to_string(&signed_tx.transaction).map_err(to_napi_err)?;
    Ok(format!(
      r#"{{"signature":"{}","transaction":{}}}"#,
      signed_tx.signature.0, tx_json
    ))
  }

  // --- Session Queries ---

  /// Get all session IDs as native array
  #[napi]
  pub fn get_session_ids(&self, co_id: String) -> napi::Result<Vec<String>> {
    Ok(
      self
        .internal
        .get(&co_id)
        .map_err(to_napi_err)?
        .get_session_ids(),
    )
  }

  /// Get transaction count for a session (returns -1 if session not found)
  #[napi]
  pub fn get_transaction_count(&self, co_id: String, session_id: String) -> napi::Result<i32> {
    let sm = self.internal.get(&co_id).map_err(to_napi_err)?;
    // Same -1-if-absent convention as the SessionMap wrapper
    Ok(
      sm.get_transaction_count(&session_id)
        .map(|c| c as i32)
        .unwrap_or(-1),
    )
  }

  /// Get single transaction by index as JSON string (returns undefined if not found)
  #[napi]
  pub fn get_transaction(
    &self,
    co_id: String,
    session_id: String,
    tx_index: u32,
  ) -> napi::Result<Option<String>> {
    Ok(
      self
        .internal
        .get(&co_id)
        .map_err(to_napi_err)?
        .get_transaction(&session_id, tx_index),
    )
  }

  /// Get transactions for a session from index as JSON strings (returns undefined if session not found)
  #[napi]
  pub fn get_session_transactions(
    &self,
    co_id: String,
    session_id: String,
    from_index: u32,
  ) -> napi::Result<Option<Vec<String>>> {
    Ok(
      self
        .internal
        .get(&co_id)
        .map_err(to_napi_err)?
        .get_session_transactions(&session_id, from_index),
    )
  }

  /// Get last signature for a session (returns undefined if session not found)
  #[napi]
  pub fn get_last_signature(
    &self,
    co_id: String,
    session_id: String,
  ) -> napi::Result<Option<String>> {
    Ok(
      self
        .internal
        .get(&co_id)
        .map_err(to_napi_err)?
        .get_last_signature(&session_id),
    )
  }

  /// Get signature after specific transaction index
  #[napi]
  pub fn get_signature_after(
    &self,
    co_id: String,
    session_id: String,
    tx_index: u32,
  ) -> napi::Result<Option<String>> {
    Ok(
      self
        .internal
        .get(&co_id)
        .map_err(to_napi_err)?
        .get_signature_after(&session_id, tx_index),
    )
  }

  /// Get the last signature checkpoint index (-1 if no checkpoints, undefined if session not found)
  #[napi]
  pub fn get_last_signature_checkpoint(
    &self,
    co_id: String,
    session_id: String,
  ) -> napi::Result<Option<i32>> {
    Ok(
      self
        .internal
        .get(&co_id)
        .map_err(to_napi_err)?
        .get_last_signature_checkpoint(&session_id),
    )
  }

  // --- Known State ---

  /// Get the known state as a native JavaScript object
  #[napi]
  pub fn get_known_state(&self, co_id: String) -> napi::Result<KnownState> {
    Ok(
      self
        .internal
        .get(&co_id)
        .map_err(to_napi_err)?
        .get_known_state()
        .clone()
        .into(),
    )
  }

  /// Get the known state with streaming as a native JavaScript object
  #[napi]
  pub fn get_known_state_with_streaming(&self, co_id: String) -> napi::Result<Option<KnownState>> {
    Ok(
      self
        .internal
        .get(&co_id)
        .map_err(to_napi_err)?
        .get_known_state_with_streaming()
        .map(|ks| ks.clone().into()),
    )
  }

  /// Check whether the CoValue still has pending streaming content.
  #[napi]
  pub fn is_streaming(&self, co_id: String) -> napi::Result<bool> {
    Ok(
      self
        .internal
        .get(&co_id)
        .map_err(to_napi_err)?
        .is_streaming(),
    )
  }

  /// Set streaming known state
  #[napi]
  pub fn set_streaming_known_state(
    &mut self,
    co_id: String,
    streaming_json: String,
  ) -> napi::Result<()> {
    self
      .internal
      .get_mut(&co_id)
      .map_err(to_napi_err)?
      .set_streaming_known_state(&streaming_json)
      .map_err(to_napi_err)
  }

  // --- Deletion ---

  /// Mark this CoValue as deleted
  #[napi]
  pub fn mark_as_deleted(&mut self, co_id: String) -> napi::Result<()> {
    self
      .internal
      .get_mut(&co_id)
      .map_err(to_napi_err)?
      .mark_as_deleted();
    Ok(())
  }

  /// Check if this CoValue is deleted
  #[napi]
  pub fn is_deleted(&self, co_id: String) -> napi::Result<bool> {
    Ok(self.internal.get(&co_id).map_err(to_napi_err)?.is_deleted())
  }

  // --- Decryption ---

  /// Decrypt transaction changes
  #[napi]
  pub fn decrypt_transaction(
    &self,
    co_id: String,
    session_id: String,
    tx_index: u32,
    key_secret: String,
  ) -> napi::Result<Option<String>> {
    self
      .internal
      .get(&co_id)
      .map_err(to_napi_err)?
      .decrypt_transaction(&session_id, tx_index, &key_secret)
      .map_err(to_napi_err)
  }

  /// Decrypt transaction meta
  #[napi]
  pub fn decrypt_transaction_meta(
    &self,
    co_id: String,
    session_id: String,
    tx_index: u32,
    key_secret: String,
  ) -> napi::Result<Option<String>> {
    self
      .internal
      .get(&co_id)
      .map_err(to_napi_err)?
      .decrypt_transaction_meta(&session_id, tx_index, &key_secret)
      .map_err(to_napi_err)
  }

  // === Stage 2/3: Group engine surface ===
  // These two methods are NodeCore-ONLY — there is no SessionMap twin (the
  // group engine is inherently cross-CoValue, so it can't live on a single
  // SessionMap). Do not go looking for a `parallel copy` in `impl SessionMap`
  // above; the "lifted verbatim" breadcrumb on that section doesn't apply here.

  /// Validate a group/account CoValue; verdicts for ALL its transactions in validation order.
  /// Throws "Unknown CoValue: <id>" if `co_id` itself is not registered, and
  /// "CoValue not loaded: <id>" if a dependency (parent group / owning account) is missing.
  #[napi]
  pub fn validate_transactions(
    &mut self,
    co_id: String,
    pending: Vec<PendingTx>,
  ) -> napi::Result<Vec<GroupVerdict>> {
    let pending = to_rust_pending(pending);
    let verdicts = self
      .internal
      .validate_transactions(&co_id, &pending)
      .map_err(to_napi_err)?;
    Ok(verdicts.into_iter().map(to_napi_verdict).collect())
  }

  /// Delta counterpart of `validate_transactions`: given the caller's
  /// `(since_generation, since_count)` cursor, return only the verdicts it has
  /// not seen. On a generation match returns `verdicts[since_count..]` with
  /// `from_index = since_count`; on a mismatch returns the whole list with
  /// `from_index = 0`. Same error contract as `validate_transactions`.
  #[napi]
  pub fn validate_transactions_delta(
    &mut self,
    co_id: String,
    since_generation: f64,
    since_count: u32,
    pending: Vec<PendingTx>,
  ) -> napi::Result<VerdictDelta> {
    let pending = to_rust_pending(pending);
    let delta = self
      .internal
      .validate_transactions_delta(&co_id, since_generation as u64, since_count, &pending)
      .map_err(to_napi_err)?;
    Ok(to_napi_delta(delta))
  }

  /// Drop the cached validation engine for `co_id`, forcing a full recompute
  /// on the next `validate_transactions` / `role_of`. An absent `co_id` is a
  /// no-op (not `UnknownCoValue`): callers invoke this on dependants that may
  /// never have been registered on this node, so erroring would be hostile.
  #[napi]
  pub fn reset_validation(&mut self, co_id: String) {
    self.internal.reset_validation(&co_id);
  }

  /// Role of member in group at time (ms). Returns the role string or null.
  /// Throws "Unknown CoValue: <id>" if `group_id` itself is not registered, and
  /// "CoValue not loaded: <id>" if a parent group / owning account is missing.
  #[napi]
  pub fn role_of(
    &mut self,
    group_id: String,
    member: String,
    at_time: Option<f64>,
  ) -> napi::Result<Option<String>> {
    let role = self
      .internal
      .role_of(&group_id, &member, at_time.map(|v| v as u64))
      .map_err(to_napi_err)?;
    Ok(role.map(|r| r.as_str().to_string()))
  }

  // === R0 coMap materialization (experimental) ===
  // Three read-boundary candidates benchmarked in R0. `mapMaterialize` is the
  // only mutating path; the read methods operate on the cached view.

  /// Materialize (or incrementally refresh) `co_id`'s coMap view; returns the
  /// current monotonic version. Call after each ingest batch.
  #[napi]
  pub fn map_materialize(&mut self, co_id: String, pending: Vec<PendingTx>) -> napi::Result<f64> {
    let pending: Vec<RustPendingTxIn> = pending
      .into_iter()
      .map(|p| RustPendingTxIn {
        session_id: p.session_id,
        tx_index: p.tx_index,
        source_made_at: p.source_made_at.map(|v| v as u64),
        meta_json: p.meta_json,
        source_tx_id: p.source_tx_id.map(|s| (s.session_id, s.tx_index)),
      })
      .collect();
    Ok(
      self
        .internal
        .map_materialize(&co_id, &pending)
        .map_err(to_napi_err)? as f64,
    )
  }

  /// Boundary (a): latest JSON value for `key`, or null.
  #[napi]
  pub fn map_get(&self, co_id: String, key: String) -> napi::Result<Option<String>> {
    self.internal.map_get(&co_id, &key).map_err(to_napi_err)
  }

  /// Boundary (a): JSON value for `key` at `at_time` (ms; omit for latest).
  #[napi]
  pub fn map_get_at(
    &self,
    co_id: String,
    key: String,
    at_time: Option<f64>,
  ) -> napi::Result<Option<String>> {
    self
      .internal
      .map_get_at(&co_id, &key, at_time.map(|v| v as u64))
      .map_err(to_napi_err)
  }

  /// Boundary (b): whole materialized map as a JSON object string.
  #[napi]
  pub fn map_snapshot(&self, co_id: String) -> napi::Result<String> {
    self.internal.map_snapshot(&co_id).map_err(to_napi_err)
  }

  /// Boundary (c): `{version, changedKeys, deletedKeys}` since `since_version`.
  #[napi]
  pub fn map_delta(&self, co_id: String, since_version: f64) -> napi::Result<String> {
    self
      .internal
      .map_delta(&co_id, since_version as u64)
      .map_err(to_napi_err)
  }

  /// Boundary (c-rich): `{version, reset, changedKeys}` since `since_version`,
  /// each `changedKeys[k]` the full `MapOp[]` op-list — the payload a TS
  /// `RawCoMap` rebuilds `ops`/`latest` from.
  #[napi]
  pub fn map_delta_rich(&self, co_id: String, since_version: f64) -> napi::Result<String> {
    self
      .internal
      .map_delta_rich(&co_id, since_version as u64)
      .map_err(to_napi_err)
  }

  /// Boundary (c-lazy): the full ordered `MapOp[]` for a SINGLE key as a JSON
  /// array string (`[]` if absent). The lazy per-key counterpart to
  /// `mapDeltaRich`: a TS `RawCoMap` pulls this ONLY when a rich accessor first
  /// touches the key, so ingest transfers only latest values (the cheap
  /// `mapDelta`), never the per-op history of un-inspected keys.
  #[napi]
  pub fn map_ops_for_key(&self, co_id: String, key: String) -> napi::Result<String> {
    self
      .internal
      .map_ops_for_key(&co_id, &key)
      .map_err(to_napi_err)
  }

  /// Frontier read: latest frontier-visible value of `key` (null = absent).
  /// `frontier_json` is `{ sessionID: txCount }`.
  #[napi]
  pub fn map_get_at_frontier(
    &self,
    co_id: String,
    key: String,
    frontier_json: String,
  ) -> napi::Result<Option<String>> {
    self
      .internal
      .map_get_at_frontier(&co_id, &key, &frontier_json)
      .map_err(to_napi_err)
  }

  /// Frontier read: whole `{key: latestVisibleValue}` snapshot under
  /// `frontier_json` as a JSON object string.
  #[napi]
  pub fn map_snapshot_at_frontier(
    &self,
    co_id: String,
    frontier_json: String,
  ) -> napi::Result<String> {
    self
      .internal
      .map_snapshot_at_frontier(&co_id, &frontier_json)
      .map_err(to_napi_err)
  }

  /// R3 stage-1 single-call ingest: add a content chunk's transactions, validate
  /// them in-crate, and materialize the coMap view in ONE crossing — returning
  /// only the compact `IngestOutcome` (no per-transaction verdict array). The raw
  /// session log is still written, so TS sync/storage (which read raw sessions)
  /// are unaffected. See `NodeCore::ingest_and_materialize`.
  #[napi]
  #[allow(clippy::too_many_arguments)]
  pub fn ingest_and_materialize(
    &mut self,
    co_id: String,
    session_id: String,
    signer_id: Option<String>,
    transactions_json: String,
    signature: String,
    skip_verify: bool,
    since_version: f64,
    pending: Vec<PendingTx>,
  ) -> napi::Result<IngestOutcome> {
    let out = self
      .internal
      .ingest_and_materialize(
        &co_id,
        &session_id,
        signer_id.as_deref(),
        &transactions_json,
        &signature,
        skip_verify,
        since_version as u64,
        &to_rust_pending(pending),
      )
      .map_err(to_napi_err)?;
    Ok(to_napi_ingest(out))
  }

  // === R1 key store (experimental) ===

  /// Feed a resolved `KeyID -> KeySecret` to the native key store (idempotent).
  /// TS calls this once it has unsealed a private tx's read key; native
  /// materialization then decrypts that tx internally.
  #[napi]
  pub fn provide_key_secret(&mut self, key_id: String, key_secret: String) {
    self.internal.provide_key_secret(&key_id, &key_secret);
  }

  /// Whether a secret for `key_id` has been provided.
  #[napi]
  pub fn has_key_secret(&self, key_id: String) -> bool {
    self.internal.has_key_secret(&key_id)
  }

  /// The `KeyID`s `co_id`'s materialized view still needs a secret for.
  #[napi]
  pub fn missing_key_ids(&self, co_id: String) -> Vec<String> {
    self.internal.missing_key_ids(&co_id)
  }
}

// ============================================================================
// Hash Functions
// ============================================================================

/// Compute a short hash of a stable-stringified JSON value.
/// The input should already be serialized using stableStringify on the JS side.
/// Returns a string prefixed with "shortHash_z" followed by base58-encoded hash.
#[napi]
pub fn short_hash(value: String) -> String {
  cojson_core::hash::blake3::short_hash(&value)
}
