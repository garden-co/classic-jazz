use cojson_core::core::{CoJsonCoreError, SessionMapImpl};
use serde::Serialize;
use std::sync::Once;
use thiserror::Error;
use wasm_bindgen::prelude::*;

#[wasm_bindgen(inline_js = "
export function dumpWasmPanic(message) {
  queueMicrotask(() => {
    throw new Error(`Wasm panic: ${message}`);
  })
}
")]
extern "C" {
    #[wasm_bindgen(js_name = dumpWasmPanic)]
    fn dump_wasm_panic(message: &str);
}

#[cfg(feature = "console_error_panic_hook")]
fn install_panic_hook() {
    static INSTALL_PANIC_HOOK: Once = Once::new();

    INSTALL_PANIC_HOOK.call_once(|| {
        std::panic::set_hook(Box::new(|panic_info| {
            dump_wasm_panic(&panic_info.to_string());
            console_error_panic_hook::hook(panic_info);
        }));
    });
}

#[cfg(not(feature = "console_error_panic_hook"))]
fn install_panic_hook() {}

#[wasm_bindgen(start)]
pub fn init() {
    install_panic_hook();
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
pub enum CojsonCoreWasmError {
    #[error(transparent)]
    CoJson(#[from] CoJsonCoreError),
    #[error(transparent)]
    Serde(#[from] serde_json::Error),
    #[error(transparent)]
    SerdeWasmBindgen(#[from] serde_wasm_bindgen::Error),
    #[error("JsValue Error: {0:?}")]
    Js(JsValue),
}

impl From<CojsonCoreWasmError> for JsValue {
    fn from(err: CojsonCoreWasmError) -> Self {
        JsValue::from_str(&err.to_string())
    }
}

fn serialize_js_value<T>(value: T) -> JsValue
where
    T: Serialize,
{
    let serializer = serde_wasm_bindgen::Serializer::new().serialize_maps_as_objects(true);
    value
        .serialize(&serializer)
        .expect("KnownState serialization should not fail")
}

// ============================================================================
// SessionMap - WASM wrapper for SessionMapImpl
// ============================================================================

#[wasm_bindgen]
pub struct SessionMap {
    internal: SessionMapImpl,
}

#[wasm_bindgen]
impl SessionMap {
    /// Create a new SessionMap for a CoValue
    /// `max_tx_size` is the threshold for recording in-between signatures (default: 100KB)
    /// Create a new SessionMap for a CoValue.
    /// Validates the header and verifies that `co_id` matches the hash of the header.
    /// `max_tx_size` is the threshold for recording in-between signatures (default: 100KB)
    /// `skip_verify` if true, skips uniqueness and ID validation (for trusted storage shards)
    #[wasm_bindgen(constructor)]
    pub fn new(
        co_id: String,
        header_json: String,
        max_tx_size: Option<u32>,
        skip_verify: Option<bool>,
    ) -> Result<SessionMap, CojsonCoreWasmError> {
        let internal = SessionMapImpl::new_with_skip_verify(
            &co_id,
            &header_json,
            max_tx_size,
            skip_verify.unwrap_or(false),
        )
        .map_err(|e| CojsonCoreWasmError::Js(JsValue::from_str(&e.to_string())))?;
        Ok(SessionMap { internal })
    }

    // === Header ===

    /// Get the header as JSON
    #[wasm_bindgen(js_name = getHeader)]
    pub fn get_header(&self) -> String {
        self.internal.get_header()
    }

    // === Transaction Operations ===

    /// Add transactions to a session
    #[wasm_bindgen(js_name = addTransactions)]
    pub fn add_transactions(
        &mut self,
        session_id: String,
        signer_id: Option<String>,
        transactions_json: String,
        signature: String,
        skip_verify: bool,
    ) -> Result<(), CojsonCoreWasmError> {
        self.internal
            .add_transactions(
                &session_id,
                signer_id.as_deref(),
                &transactions_json,
                &signature,
                skip_verify,
            )
            .map_err(|e| CojsonCoreWasmError::Js(JsValue::from_str(&e.to_string())))
    }

    /// Create new private transaction (for local writes)
    /// Returns JSON: { signature: string, transaction: Transaction }
    #[wasm_bindgen(js_name = makeNewPrivateTransaction)]
    pub fn make_new_private_transaction(
        &mut self,
        session_id: String,
        signer_secret: String,
        changes_json: String,
        key_id: String,
        key_secret: String,
        meta_json: Option<String>,
        made_at: f64,
    ) -> Result<String, CojsonCoreWasmError> {
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
            .map_err(|e| CojsonCoreWasmError::Js(JsValue::from_str(&e.to_string())))?;

        let tx_json = serde_json::to_string(&signed_tx.transaction)
            .map_err(|e| CojsonCoreWasmError::Js(JsValue::from_str(&e.to_string())))?;
        Ok(format!(
            r#"{{"signature":"{}","transaction":{}}}"#,
            signed_tx.signature.0, tx_json
        ))
    }

    /// Create new trusting transaction (for local writes)
    /// Returns JSON: { signature: string, transaction: Transaction }
    #[wasm_bindgen(js_name = makeNewTrustingTransaction)]
    pub fn make_new_trusting_transaction(
        &mut self,
        session_id: String,
        signer_secret: String,
        changes_json: String,
        meta_json: Option<String>,
        made_at: f64,
    ) -> Result<String, CojsonCoreWasmError> {
        let signed_tx = self
            .internal
            .make_new_trusting_transaction(
                session_id,
                signer_secret,
                &changes_json,
                meta_json,
                made_at as u64,
            )
            .map_err(|e| CojsonCoreWasmError::Js(JsValue::from_str(&e.to_string())))?;

        let tx_json = serde_json::to_string(&signed_tx.transaction)
            .map_err(|e| CojsonCoreWasmError::Js(JsValue::from_str(&e.to_string())))?;
        Ok(format!(
            r#"{{"signature":"{}","transaction":{}}}"#,
            signed_tx.signature.0, tx_json
        ))
    }

    // === Session Queries ===

    /// Get all session IDs as native array
    #[wasm_bindgen(js_name = getSessionIds)]
    pub fn get_session_ids(&self) -> Vec<String> {
        self.internal.get_session_ids()
    }

    /// Get transaction count for a session (returns -1 if session not found)
    #[wasm_bindgen(js_name = getTransactionCount)]
    pub fn get_transaction_count(&self, session_id: String) -> i32 {
        self.internal
            .get_transaction_count(&session_id)
            .map(|c| c as i32)
            .unwrap_or(-1)
    }

    /// Get single transaction by index as JSON string (returns undefined if not found)
    #[wasm_bindgen(js_name = getTransaction)]
    pub fn get_transaction(&self, session_id: String, tx_index: u32) -> Option<String> {
        self.internal.get_transaction(&session_id, tx_index)
    }

    /// Get transactions for a session from index as JSON strings (returns undefined if session not found)
    #[wasm_bindgen(js_name = getSessionTransactions)]
    pub fn get_session_transactions(
        &self,
        session_id: String,
        from_index: u32,
    ) -> Option<Vec<String>> {
        self.internal
            .get_session_transactions(&session_id, from_index)
    }

    /// Get last signature for a session (returns undefined if session not found)
    #[wasm_bindgen(js_name = getLastSignature)]
    pub fn get_last_signature(&self, session_id: String) -> Option<String> {
        self.internal.get_last_signature(&session_id)
    }

    /// Get signature after specific transaction index
    #[wasm_bindgen(js_name = getSignatureAfter)]
    pub fn get_signature_after(&self, session_id: String, tx_index: u32) -> Option<String> {
        self.internal.get_signature_after(&session_id, tx_index)
    }

    /// Get the last signature checkpoint index (-1 if no checkpoints, undefined if session not found)
    #[wasm_bindgen(js_name = getLastSignatureCheckpoint)]
    pub fn get_last_signature_checkpoint(&self, session_id: String) -> Option<i32> {
        self.internal.get_last_signature_checkpoint(&session_id)
    }

    // === Known State ===

    /// Get the known state as a native JavaScript object
    #[wasm_bindgen(js_name = getKnownState)]
    pub fn get_known_state(&self) -> JsValue {
        serialize_js_value(self.internal.get_known_state().clone())
    }

    /// Get the known state with streaming as a native JavaScript object
    #[wasm_bindgen(js_name = getKnownStateWithStreaming)]
    pub fn get_known_state_with_streaming(&self) -> JsValue {
        self.internal
            .get_known_state_with_streaming()
            .cloned()
            .map(serialize_js_value)
            .unwrap_or_else(JsValue::undefined)
    }

    /// Check whether the CoValue still has pending streaming content.
    #[wasm_bindgen(js_name = isStreaming)]
    pub fn is_streaming(&self) -> bool {
        self.internal.is_streaming()
    }

    /// Set streaming known state
    #[wasm_bindgen(js_name = setStreamingKnownState)]
    pub fn set_streaming_known_state(
        &mut self,
        streaming_json: String,
    ) -> Result<(), CojsonCoreWasmError> {
        self.internal
            .set_streaming_known_state(&streaming_json)
            .map_err(|e| CojsonCoreWasmError::Js(JsValue::from_str(&e.to_string())))
    }

    // === Deletion ===

    /// Mark this CoValue as deleted
    #[wasm_bindgen(js_name = markAsDeleted)]
    pub fn mark_as_deleted(&mut self) {
        self.internal.mark_as_deleted();
    }

    /// Check if this CoValue is deleted
    #[wasm_bindgen(js_name = isDeleted)]
    pub fn is_deleted(&self) -> bool {
        self.internal.is_deleted()
    }

    // === Decryption ===

    /// Decrypt transaction changes
    #[wasm_bindgen(js_name = decryptTransaction)]
    pub fn decrypt_transaction(
        &self,
        session_id: String,
        tx_index: u32,
        key_secret: String,
    ) -> Result<Option<String>, CojsonCoreWasmError> {
        self.internal
            .decrypt_transaction(&session_id, tx_index, &key_secret)
            .map_err(|e| CojsonCoreWasmError::Js(JsValue::from_str(&e.to_string())))
    }

    /// Decrypt transaction meta
    #[wasm_bindgen(js_name = decryptTransactionMeta)]
    pub fn decrypt_transaction_meta(
        &self,
        session_id: String,
        tx_index: u32,
        key_secret: String,
    ) -> Result<Option<String>, CojsonCoreWasmError> {
        self.internal
            .decrypt_transaction_meta(&session_id, tx_index, &key_secret)
            .map_err(|e| CojsonCoreWasmError::Js(JsValue::from_str(&e.to_string())))
    }

    /// Decrypt many transactions in one call. `indices` is a `Uint32Array`.
    /// Returns a JSON array string (element `i` is the decrypted changes of
    /// `indices[i]`, or `null` if that tx could not be decrypted), or
    /// `undefined` if the session does not exist.
    #[wasm_bindgen(js_name = decryptTransactions)]
    pub fn decrypt_transactions(
        &self,
        session_id: &str,
        indices: &[u32],
        key_secret: &str,
    ) -> Option<String> {
        self.internal
            .decrypt_transactions(session_id, indices, key_secret)
    }
}
