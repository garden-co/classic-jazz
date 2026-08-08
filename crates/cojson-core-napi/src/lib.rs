use cojson_core::core::{CoJsonCoreError, KnownState as RustKnownState, SessionMapImpl};
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

  /// Decrypt many transactions in one call. Returns a JSON array string
  /// (element `i` is the decrypted changes of `indices[i]`, or `null` if that
  /// tx could not be decrypted), or `undefined` if the session does not exist.
  #[napi]
  pub fn decrypt_transactions(
    &self,
    session_id: String,
    indices: Vec<u32>,
    key_secret: String,
  ) -> Option<String> {
    self
      .internal
      .decrypt_transactions(&session_id, &indices, &key_secret)
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
