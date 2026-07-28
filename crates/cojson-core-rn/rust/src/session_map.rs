use cojson_core::core::{KnownState as RustKnownState, SessionMapImpl};
use std::collections::HashMap;
use thiserror::Error;

#[derive(Error, Debug, uniffi::Error)]
pub enum SessionMapError {
    /// Wraps any inner `cojson-core` error's `Display` output VERBATIM — no
    /// added prefix. This is load-bearing once `NodeCore` (node_core.rs)
    /// reuses this same variant for its registry-lookup errors: TS-side error
    /// translation does `message.startsWith("CoValue not loaded: ")`
    /// (packages/cojson/src/permissions.ts:322) and matches `"Unknown CoValue: "`
    /// similarly, so a wrapped format like the previous `"SessionMap error: {0}"`
    /// would silently break that match by shifting the prefix. Kept as a plain
    /// format string rather than `#[error(transparent)]`, since `String` doesn't
    /// implement `std::error::Error`; kept as one variant rather than adding a
    /// parallel one, since nothing in the tree depended on the old
    /// "SessionMap error: " prefix text.
    #[error("{0}")]
    Internal(String),
    #[error("Failed to acquire lock")]
    LockError,
}

/// KnownState as a native Record (no JSON serialization needed)
#[derive(uniffi::Record, Clone, Debug)]
pub struct KnownState {
    pub id: String,
    pub header: bool,
    pub sessions: HashMap<String, u32>,
}

impl From<&RustKnownState> for KnownState {
    fn from(ks: &RustKnownState) -> Self {
        KnownState {
            id: ks.id.clone(),
            header: ks.header,
            sessions: ks.sessions.iter().map(|(k, v)| (k.clone(), *v)).collect(),
        }
    }
}

#[derive(uniffi::Object)]
pub struct SessionMap {
    internal: std::sync::Mutex<SessionMapImpl>,
}

// NOTE: a parallel copy of every method body below lives in `impl NodeCore`
// (node_core.rs, co_id-first). When editing a method here, update its
// NodeCore twin too — see the matching breadcrumb on `impl NodeCore` in that
// file.
#[uniffi::export]
impl SessionMap {
    /// Create a new SessionMap for a CoValue
    /// Create a new SessionMap for a CoValue.
    /// Validates the header and verifies that `co_id` matches the hash of the header.
    /// `max_tx_size` is the threshold for recording in-between signatures (default: 100KB)
    /// `skip_verify` if true, skips uniqueness and ID validation (for trusted storage shards)
    #[uniffi::constructor]
    pub fn new(
        co_id: String,
        header_json: String,
        max_tx_size: Option<u32>,
        skip_verify: Option<bool>,
    ) -> Result<Self, SessionMapError> {
        let internal = SessionMapImpl::new_with_skip_verify(
            &co_id,
            &header_json,
            max_tx_size,
            skip_verify.unwrap_or(false),
        )
        .map_err(|e| SessionMapError::Internal(e.to_string()))?;
        Ok(SessionMap {
            internal: std::sync::Mutex::new(internal),
        })
    }

    // === Header ===

    /// Get the header as JSON
    pub fn get_header(&self) -> Result<String, SessionMapError> {
        let internal = self
            .internal
            .lock()
            .map_err(|_| SessionMapError::LockError)?;
        Ok(internal.get_header())
    }

    // === Transaction Operations ===

    /// Add transactions to a session
    pub fn add_transactions(
        &self,
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
    pub fn make_new_private_transaction(
        &self,
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

    // === Session Queries ===

    /// Get all session IDs as native array
    pub fn get_session_ids(&self) -> Result<Vec<String>, SessionMapError> {
        let internal = self
            .internal
            .lock()
            .map_err(|_| SessionMapError::LockError)?;
        Ok(internal.get_session_ids())
    }

    /// Get transaction count for a session (returns -1 if session not found)
    pub fn get_transaction_count(&self, session_id: String) -> Result<i32, SessionMapError> {
        let internal = self
            .internal
            .lock()
            .map_err(|_| SessionMapError::LockError)?;
        Ok(internal
            .get_transaction_count(&session_id)
            .map(|c| c as i32)
            .unwrap_or(-1))
    }

    /// Get single transaction by index as JSON string (returns None if not found)
    pub fn get_transaction(
        &self,
        session_id: String,
        tx_index: u32,
    ) -> Result<Option<String>, SessionMapError> {
        let internal = self
            .internal
            .lock()
            .map_err(|_| SessionMapError::LockError)?;
        Ok(internal.get_transaction(&session_id, tx_index))
    }

    /// Get transactions for a session from index as JSON strings (returns None if session not found)
    pub fn get_session_transactions(
        &self,
        session_id: String,
        from_index: u32,
    ) -> Result<Option<Vec<String>>, SessionMapError> {
        let internal = self
            .internal
            .lock()
            .map_err(|_| SessionMapError::LockError)?;
        Ok(internal.get_session_transactions(&session_id, from_index))
    }

    /// Get last signature for a session (returns None if session not found)
    pub fn get_last_signature(
        &self,
        session_id: String,
    ) -> Result<Option<String>, SessionMapError> {
        let internal = self
            .internal
            .lock()
            .map_err(|_| SessionMapError::LockError)?;
        Ok(internal.get_last_signature(&session_id))
    }

    /// Get signature after specific transaction index
    pub fn get_signature_after(
        &self,
        session_id: String,
        tx_index: u32,
    ) -> Result<Option<String>, SessionMapError> {
        let internal = self
            .internal
            .lock()
            .map_err(|_| SessionMapError::LockError)?;
        Ok(internal.get_signature_after(&session_id, tx_index))
    }

    /// Get the last signature checkpoint index (-1 if no checkpoints, None if session not found)
    pub fn get_last_signature_checkpoint(
        &self,
        session_id: String,
    ) -> Result<Option<i32>, SessionMapError> {
        let internal = self
            .internal
            .lock()
            .map_err(|_| SessionMapError::LockError)?;
        Ok(internal.get_last_signature_checkpoint(&session_id))
    }

    // === Known State ===

    /// Get the known state as a native Record
    pub fn get_known_state(&self) -> Result<KnownState, SessionMapError> {
        let internal = self
            .internal
            .lock()
            .map_err(|_| SessionMapError::LockError)?;
        Ok(internal.get_known_state().into())
    }

    /// Get the known state with streaming as a native Record
    pub fn get_known_state_with_streaming(&self) -> Result<Option<KnownState>, SessionMapError> {
        let internal = self
            .internal
            .lock()
            .map_err(|_| SessionMapError::LockError)?;
        Ok(internal
            .get_known_state_with_streaming()
            .map(|ks| ks.into()))
    }

    /// Check whether the CoValue still has pending streaming content.
    pub fn is_streaming(&self) -> Result<bool, SessionMapError> {
        let internal = self
            .internal
            .lock()
            .map_err(|_| SessionMapError::LockError)?;
        Ok(internal.is_streaming())
    }

    /// Set streaming known state
    pub fn set_streaming_known_state(&self, streaming_json: String) -> Result<(), SessionMapError> {
        let mut internal = self
            .internal
            .lock()
            .map_err(|_| SessionMapError::LockError)?;
        internal
            .set_streaming_known_state(&streaming_json)
            .map_err(|e| SessionMapError::Internal(e.to_string()))
    }

    // === Deletion ===

    /// Mark this CoValue as deleted
    pub fn mark_as_deleted(&self) -> Result<(), SessionMapError> {
        let mut internal = self
            .internal
            .lock()
            .map_err(|_| SessionMapError::LockError)?;
        internal.mark_as_deleted();
        Ok(())
    }

    /// Check if this CoValue is deleted
    pub fn is_deleted(&self) -> Result<bool, SessionMapError> {
        let internal = self
            .internal
            .lock()
            .map_err(|_| SessionMapError::LockError)?;
        Ok(internal.is_deleted())
    }

    // === Decryption ===

    /// Decrypt transaction changes
    pub fn decrypt_transaction(
        &self,
        session_id: String,
        tx_index: u32,
        key_secret: String,
    ) -> Result<Option<String>, SessionMapError> {
        let internal = self
            .internal
            .lock()
            .map_err(|_| SessionMapError::LockError)?;
        internal
            .decrypt_transaction(&session_id, tx_index, &key_secret)
            .map_err(|e| SessionMapError::Internal(e.to_string()))
    }

    /// Decrypt transaction meta
    pub fn decrypt_transaction_meta(
        &self,
        session_id: String,
        tx_index: u32,
        key_secret: String,
    ) -> Result<Option<String>, SessionMapError> {
        let internal = self
            .internal
            .lock()
            .map_err(|_| SessionMapError::LockError)?;
        internal
            .decrypt_transaction_meta(&session_id, tx_index, &key_secret)
            .map_err(|e| SessionMapError::Internal(e.to_string()))
    }
}
