use cojson_core::core::{
    CoJsonCoreError, IngestOutcome as RustIngestOutcome, NodeCore as RustNodeCore,
    PendingTxIn as RustPendingTxIn, SessionMapImpl, Verdict as RustVerdict,
    VerdictDelta as RustVerdictDelta,
};
use serde::{Deserialize, Serialize};
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

// NOTE: a parallel copy of every method body below lives in `impl NodeCore`
// (co_id-first). When editing a method here, update its NodeCore twin too —
// see the matching breadcrumb on `impl NodeCore` further down this file.
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
}

// ============================================================================
// NodeCore - WASM wrapper for the node-level CoValue registry
// ============================================================================

/// Map any error implementing Display straight into a `JsValue`, preserving
/// the message verbatim (single wrap, no intermediate `CojsonCoreWasmError`).
///
/// NodeCore deliberately does NOT reuse the `CojsonCoreWasmError::Js(...)`
/// round trip the `SessionMap` methods above use: that path Debug-formats the
/// already-stringified inner `JsValue` a second time (via
/// `CojsonCoreWasmError`'s `#[error("JsValue Error: {0:?}")]` on conversion to
/// `JsValue`), which would prefix every message with `"JsValue Error: "` and
/// mangle the `SessionMapError` text. The registry lookup errors
/// ("Unknown CoValue: ", "CoValue not loaded: ") are load-bearing for
/// TS-side error translation, so NodeCore's methods return `Result<_, JsValue>`
/// directly and convert with this helper instead — mirroring napi's
/// `to_napi_err`, which has the same single-wrap property.
fn to_wasm_err<E: std::fmt::Display>(e: E) -> JsValue {
    JsValue::from_str(&e.to_string())
}

/// Wire shape of a merged transaction's source identity for
/// `validateTransactions`'s `pending` argument, matching the nested
/// `sourceTxId` object of `NodeCorePendingTx` (crypto.ts) VERBATIM:
/// `{sessionID, txIndex}` — NOTE the capital-ID casing here, same convention
/// as `TransactionID` elsewhere in this codebase, and DIFFERENT from the
/// top-level `sessionId` (lowercase d) on `PendingTxWire` below. See
/// `PendingTxWire`'s doc comment for why this asymmetry is intentional and
/// reproduced deliberately rather than normalized away.
#[derive(Debug, Clone, Deserialize)]
struct SourceTxIdWire {
    #[serde(rename = "sessionID")]
    session_id: String,
    #[serde(rename = "txIndex")]
    tx_index: u32,
}

/// Wire shape for a pending (not-yet-persisted) transaction handed to
/// `validateTransactions`, matching `NodeCorePendingTx` (crypto.ts:~415-425)
/// VERBATIM: `{sessionId, txIndex, sourceMadeAt?, metaJson?, sourceTxId?:
/// {sessionID, txIndex}}`.
///
/// Unlike the napi binding — whose `#[napi(object)]` types bypass serde
/// entirely and so need `NapiNodeCoreAdapter` to bridge the TS `sessionID`
/// casing to the napi object's plain `sessionId` field — wasm's
/// `validateTransactions` deserializes its `JsValue` argument THROUGH serde
/// (`serde_wasm_bindgen::from_value`). That means this wire struct's own
/// `#[serde(rename)]`s can just reproduce the TS shape's casing asymmetry
/// directly (`sessionId` at the top level, `sessionID` nested inside
/// `sourceTxId`), making the TS adapter a pure pass-through with ZERO
/// conversion — no casing bridge needed on either side of the wasm boundary.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PendingTxWire {
    session_id: String,
    tx_index: u32,
    #[serde(default)]
    source_made_at: Option<f64>,
    #[serde(default)]
    meta_json: Option<String>,
    #[serde(default)]
    source_tx_id: Option<SourceTxIdWire>,
}

/// Wire shape of a single validation verdict returned by
/// `validateTransactions`, matching `NodeCoreGroupVerdict` (crypto.ts)
/// verbatim: `{sessionId, txIndex, valid, outcome, reason?}`. Serialized via
/// `serialize_js_value`, so plain camelCase (no nested casing asymmetry, this
/// is a flat object).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct GroupVerdictWire {
    session_id: String,
    tx_index: u32,
    valid: bool,
    /// One of "valid" / "invalid" / "validBranchPointerOnly", mirroring
    /// `VerdictOutcome::as_str` on the Rust side.
    outcome: String,
    reason: Option<String>,
}

impl From<RustVerdict> for GroupVerdictWire {
    fn from(v: RustVerdict) -> Self {
        GroupVerdictWire {
            session_id: v.session_id,
            tx_index: v.tx_index,
            valid: v.valid,
            outcome: v.outcome.as_str().to_string(),
            reason: v.reason,
        }
    }
}

/// Wire shape of a validation-verdict DELTA returned by
/// `validateTransactionsDelta`, mirroring `VerdictDelta` on the Rust side:
/// `{generation, fromIndex, verdicts}`. `generation` is an `f64` for lossless
/// JS-number round-tripping of the u64 counter.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct VerdictDeltaWire {
    generation: f64,
    from_index: u32,
    verdicts: Vec<GroupVerdictWire>,
}

impl From<RustVerdictDelta> for VerdictDeltaWire {
    fn from(d: RustVerdictDelta) -> Self {
        VerdictDeltaWire {
            generation: d.generation as f64,
            from_index: d.from_index,
            verdicts: d.verdicts.into_iter().map(GroupVerdictWire::from).collect(),
        }
    }
}

/// Wire shape of the R3 stage-1 single-call ingest result, mirroring
/// `IngestOutcome` on the Rust side: `{generation, count, viewVersion, deltaJson}`.
/// `generation`/`viewVersion` are `f64` for lossless JS-number round-tripping.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct IngestOutcomeWire {
    generation: f64,
    count: u32,
    view_version: f64,
    delta_json: String,
}

impl From<RustIngestOutcome> for IngestOutcomeWire {
    fn from(o: RustIngestOutcome) -> Self {
        IngestOutcomeWire {
            generation: o.generation as f64,
            count: o.count,
            view_version: o.view_version as f64,
            delta_json: o.delta_json,
        }
    }
}

fn pending_wire_to_rust(pending: Vec<PendingTxWire>) -> Vec<RustPendingTxIn> {
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

#[wasm_bindgen]
pub struct NodeCore {
    internal: RustNodeCore,
}

// NOTE: a parallel copy of every method body in `impl SessionMap` above lives
// here (co_id-first). When editing a lifted method in `impl SessionMap`,
// update its NodeCore twin too — and vice versa: this comment is the other
// half of the "parallel copy" breadcrumb at the top of `impl SessionMap`.
#[wasm_bindgen]
impl NodeCore {
    /// Create a new empty NodeCore registry (one LocalNode owns one instance).
    #[wasm_bindgen(constructor)]
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
    #[wasm_bindgen(js_name = createCoValue)]
    pub fn create_co_value(
        &mut self,
        co_id: String,
        header_json: String,
        max_tx_size: Option<u32>,
        skip_verify: Option<bool>,
    ) -> Result<(), JsValue> {
        self.internal
            .create_co_value(
                &co_id,
                &header_json,
                max_tx_size,
                skip_verify.unwrap_or(false),
            )
            .map_err(to_wasm_err)
    }

    #[wasm_bindgen(js_name = hasCoValue)]
    pub fn has_co_value(&self, co_id: String) -> bool {
        self.internal.has_co_value(&co_id)
    }

    #[wasm_bindgen(js_name = removeCoValue)]
    pub fn remove_co_value(&mut self, co_id: String) -> bool {
        self.internal.remove_co_value(&co_id)
    }

    #[wasm_bindgen(js_name = coValueCount)]
    pub fn co_value_count(&self) -> u32 {
        self.internal.co_value_count() as u32
    }

    // === Lifted SessionMap surface ===
    // Each method prepends `co_id: String` and resolves the entry via
    // get()/get_mut() before delegating, mapping UnknownCoValue through
    // to_wasm_err. Method bodies are lifted verbatim from impl SessionMap
    // so every conversion (JSON strings, serialize_js_value, -1 conventions,
    // Option -> undefined) is preserved.

    // --- Header ---

    /// Get the header as JSON
    #[wasm_bindgen(js_name = getHeader)]
    pub fn get_header(&self, co_id: String) -> Result<String, JsValue> {
        Ok(self.internal.get(&co_id).map_err(to_wasm_err)?.get_header())
    }

    // --- Transaction Operations ---

    /// Add transactions to a session
    #[wasm_bindgen(js_name = addTransactions)]
    pub fn add_transactions(
        &mut self,
        co_id: String,
        session_id: String,
        signer_id: Option<String>,
        transactions_json: String,
        signature: String,
        skip_verify: bool,
    ) -> Result<(), JsValue> {
        self.internal
            .get_mut(&co_id)
            .map_err(to_wasm_err)?
            .add_transactions(
                &session_id,
                signer_id.as_deref(),
                &transactions_json,
                &signature,
                skip_verify,
            )
            .map_err(to_wasm_err)
    }

    /// Create new private transaction (for local writes)
    /// Returns JSON: { signature: string, transaction: Transaction }
    #[wasm_bindgen(js_name = makeNewPrivateTransaction)]
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
    ) -> Result<String, JsValue> {
        let signed_tx = self
            .internal
            .get_mut(&co_id)
            .map_err(to_wasm_err)?
            .make_new_private_transaction(
                session_id,
                signer_secret,
                &changes_json,
                key_id,
                key_secret,
                meta_json,
                made_at as u64,
            )
            .map_err(to_wasm_err)?;

        let tx_json = serde_json::to_string(&signed_tx.transaction).map_err(to_wasm_err)?;
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
        co_id: String,
        session_id: String,
        signer_secret: String,
        changes_json: String,
        meta_json: Option<String>,
        made_at: f64,
    ) -> Result<String, JsValue> {
        let signed_tx = self
            .internal
            .get_mut(&co_id)
            .map_err(to_wasm_err)?
            .make_new_trusting_transaction(
                session_id,
                signer_secret,
                &changes_json,
                meta_json,
                made_at as u64,
            )
            .map_err(to_wasm_err)?;

        let tx_json = serde_json::to_string(&signed_tx.transaction).map_err(to_wasm_err)?;
        Ok(format!(
            r#"{{"signature":"{}","transaction":{}}}"#,
            signed_tx.signature.0, tx_json
        ))
    }

    // --- Session Queries ---

    /// Get all session IDs as native array
    #[wasm_bindgen(js_name = getSessionIds)]
    pub fn get_session_ids(&self, co_id: String) -> Result<Vec<String>, JsValue> {
        Ok(self
            .internal
            .get(&co_id)
            .map_err(to_wasm_err)?
            .get_session_ids())
    }

    /// Get transaction count for a session (returns -1 if session not found)
    #[wasm_bindgen(js_name = getTransactionCount)]
    pub fn get_transaction_count(&self, co_id: String, session_id: String) -> Result<i32, JsValue> {
        let sm = self.internal.get(&co_id).map_err(to_wasm_err)?;
        // Same -1-if-absent convention as the SessionMap wrapper
        Ok(sm
            .get_transaction_count(&session_id)
            .map(|c| c as i32)
            .unwrap_or(-1))
    }

    /// Get single transaction by index as JSON string (returns undefined if not found)
    #[wasm_bindgen(js_name = getTransaction)]
    pub fn get_transaction(
        &self,
        co_id: String,
        session_id: String,
        tx_index: u32,
    ) -> Result<Option<String>, JsValue> {
        Ok(self
            .internal
            .get(&co_id)
            .map_err(to_wasm_err)?
            .get_transaction(&session_id, tx_index))
    }

    /// Get transactions for a session from index as JSON strings (returns undefined if session not found)
    #[wasm_bindgen(js_name = getSessionTransactions)]
    pub fn get_session_transactions(
        &self,
        co_id: String,
        session_id: String,
        from_index: u32,
    ) -> Result<Option<Vec<String>>, JsValue> {
        Ok(self
            .internal
            .get(&co_id)
            .map_err(to_wasm_err)?
            .get_session_transactions(&session_id, from_index))
    }

    /// Get last signature for a session (returns undefined if session not found)
    #[wasm_bindgen(js_name = getLastSignature)]
    pub fn get_last_signature(
        &self,
        co_id: String,
        session_id: String,
    ) -> Result<Option<String>, JsValue> {
        Ok(self
            .internal
            .get(&co_id)
            .map_err(to_wasm_err)?
            .get_last_signature(&session_id))
    }

    /// Get signature after specific transaction index
    #[wasm_bindgen(js_name = getSignatureAfter)]
    pub fn get_signature_after(
        &self,
        co_id: String,
        session_id: String,
        tx_index: u32,
    ) -> Result<Option<String>, JsValue> {
        Ok(self
            .internal
            .get(&co_id)
            .map_err(to_wasm_err)?
            .get_signature_after(&session_id, tx_index))
    }

    /// Get the last signature checkpoint index (-1 if no checkpoints, undefined if session not found)
    #[wasm_bindgen(js_name = getLastSignatureCheckpoint)]
    pub fn get_last_signature_checkpoint(
        &self,
        co_id: String,
        session_id: String,
    ) -> Result<Option<i32>, JsValue> {
        Ok(self
            .internal
            .get(&co_id)
            .map_err(to_wasm_err)?
            .get_last_signature_checkpoint(&session_id))
    }

    // --- Known State ---

    /// Get the known state as a native JavaScript object
    #[wasm_bindgen(js_name = getKnownState)]
    pub fn get_known_state(&self, co_id: String) -> Result<JsValue, JsValue> {
        Ok(serialize_js_value(
            self.internal
                .get(&co_id)
                .map_err(to_wasm_err)?
                .get_known_state()
                .clone(),
        ))
    }

    /// Get the known state with streaming as a native JavaScript object
    #[wasm_bindgen(js_name = getKnownStateWithStreaming)]
    pub fn get_known_state_with_streaming(&self, co_id: String) -> Result<JsValue, JsValue> {
        Ok(self
            .internal
            .get(&co_id)
            .map_err(to_wasm_err)?
            .get_known_state_with_streaming()
            .cloned()
            .map(serialize_js_value)
            .unwrap_or_else(JsValue::undefined))
    }

    /// Check whether the CoValue still has pending streaming content.
    #[wasm_bindgen(js_name = isStreaming)]
    pub fn is_streaming(&self, co_id: String) -> Result<bool, JsValue> {
        Ok(self
            .internal
            .get(&co_id)
            .map_err(to_wasm_err)?
            .is_streaming())
    }

    /// Set streaming known state
    #[wasm_bindgen(js_name = setStreamingKnownState)]
    pub fn set_streaming_known_state(
        &mut self,
        co_id: String,
        streaming_json: String,
    ) -> Result<(), JsValue> {
        self.internal
            .get_mut(&co_id)
            .map_err(to_wasm_err)?
            .set_streaming_known_state(&streaming_json)
            .map_err(to_wasm_err)
    }

    // --- Deletion ---

    /// Mark this CoValue as deleted
    #[wasm_bindgen(js_name = markAsDeleted)]
    pub fn mark_as_deleted(&mut self, co_id: String) -> Result<(), JsValue> {
        self.internal
            .get_mut(&co_id)
            .map_err(to_wasm_err)?
            .mark_as_deleted();
        Ok(())
    }

    /// Check if this CoValue is deleted
    #[wasm_bindgen(js_name = isDeleted)]
    pub fn is_deleted(&self, co_id: String) -> Result<bool, JsValue> {
        Ok(self.internal.get(&co_id).map_err(to_wasm_err)?.is_deleted())
    }

    // --- Decryption ---

    /// Decrypt transaction changes
    #[wasm_bindgen(js_name = decryptTransaction)]
    pub fn decrypt_transaction(
        &self,
        co_id: String,
        session_id: String,
        tx_index: u32,
        key_secret: String,
    ) -> Result<Option<String>, JsValue> {
        self.internal
            .get(&co_id)
            .map_err(to_wasm_err)?
            .decrypt_transaction(&session_id, tx_index, &key_secret)
            .map_err(to_wasm_err)
    }

    /// Decrypt transaction meta
    #[wasm_bindgen(js_name = decryptTransactionMeta)]
    pub fn decrypt_transaction_meta(
        &self,
        co_id: String,
        session_id: String,
        tx_index: u32,
        key_secret: String,
    ) -> Result<Option<String>, JsValue> {
        self.internal
            .get(&co_id)
            .map_err(to_wasm_err)?
            .decrypt_transaction_meta(&session_id, tx_index, &key_secret)
            .map_err(to_wasm_err)
    }

    // === Stage 2/3: Group engine surface ===
    // These methods are NodeCore-ONLY — there is no SessionMap twin (the
    // group engine is inherently cross-CoValue, so it can't live on a single
    // SessionMap). Do not go looking for a `parallel copy` in `impl SessionMap`
    // above; the "lifted verbatim" breadcrumb on that section doesn't apply
    // here.

    /// Validate a group/account CoValue; verdicts for ALL its transactions in
    /// validation order. `pending` is a `JsValue` array of `PendingTxWire`
    /// objects (see that struct's doc comment for the exact wire shape).
    /// Throws "Unknown CoValue: <id>" if `co_id` itself is not registered, and
    /// "CoValue not loaded: <id>" if a dependency (parent group / owning
    /// account) is missing.
    #[wasm_bindgen(js_name = validateTransactions)]
    pub fn validate_transactions(
        &mut self,
        co_id: String,
        pending: JsValue,
    ) -> Result<JsValue, JsValue> {
        let pending: Vec<PendingTxWire> = serde_wasm_bindgen::from_value(pending)
            .map_err(|e| to_wasm_err(CojsonCoreWasmError::from(e)))?;
        let pending = pending_wire_to_rust(pending);
        let verdicts = self
            .internal
            .validate_transactions(&co_id, &pending)
            .map_err(to_wasm_err)?;
        let verdicts: Vec<GroupVerdictWire> =
            verdicts.into_iter().map(GroupVerdictWire::from).collect();
        Ok(serialize_js_value(verdicts))
    }

    /// Delta counterpart of `validateTransactions`: given the caller's
    /// `(since_generation, since_count)` cursor, return only the verdicts it has
    /// not seen as a `VerdictDeltaWire` (`{generation, fromIndex, verdicts}`). On
    /// a generation match returns `verdicts[since_count..]`; on a mismatch returns
    /// the whole list with `fromIndex = 0`. Same error contract as
    /// `validateTransactions`.
    #[wasm_bindgen(js_name = validateTransactionsDelta)]
    pub fn validate_transactions_delta(
        &mut self,
        co_id: String,
        since_generation: f64,
        since_count: u32,
        pending: JsValue,
    ) -> Result<JsValue, JsValue> {
        let pending: Vec<PendingTxWire> = serde_wasm_bindgen::from_value(pending)
            .map_err(|e| to_wasm_err(CojsonCoreWasmError::from(e)))?;
        let pending = pending_wire_to_rust(pending);
        let delta = self
            .internal
            .validate_transactions_delta(&co_id, since_generation as u64, since_count, &pending)
            .map_err(to_wasm_err)?;
        Ok(serialize_js_value(VerdictDeltaWire::from(delta)))
    }

    /// Drop the cached validation engine for `co_id`, forcing a full recompute
    /// on the next `validateTransactions` / `roleOf`. An absent `co_id` is a
    /// no-op (not `UnknownCoValue`): callers invoke this on dependants that may
    /// never have been registered on this node, so erroring would be hostile.
    #[wasm_bindgen(js_name = resetValidation)]
    pub fn reset_validation(&mut self, co_id: String) {
        self.internal.reset_validation(&co_id);
    }

    /// Role of member in group at time (ms). Returns the role string or null.
    /// Throws "Unknown CoValue: <id>" if `group_id` itself is not registered,
    /// and "CoValue not loaded: <id>" if a parent group / owning account is
    /// missing.
    #[wasm_bindgen(js_name = roleOf)]
    pub fn role_of(
        &mut self,
        group_id: String,
        member: String,
        at_time: Option<f64>,
    ) -> Result<Option<String>, JsValue> {
        let role = self
            .internal
            .role_of(&group_id, &member, at_time.map(|v| v as u64))
            .map_err(to_wasm_err)?;
        Ok(role.map(|r| r.as_str().to_string()))
    }

    // === R0 coMap materialization (experimental) ===
    // Three read-boundary candidates benchmarked in R0. `mapMaterialize` is the
    // only mutating path; the read methods operate on the cached view.

    /// Materialize (or incrementally refresh) `co_id`'s coMap view; returns the
    /// current monotonic version. `pending` is a `JsValue` array of
    /// `PendingTxWire` objects (same shape as `validateTransactions`).
    #[wasm_bindgen(js_name = mapMaterialize)]
    pub fn map_materialize(&mut self, co_id: String, pending: JsValue) -> Result<f64, JsValue> {
        let pending: Vec<PendingTxWire> = serde_wasm_bindgen::from_value(pending)
            .map_err(|e| to_wasm_err(CojsonCoreWasmError::from(e)))?;
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
        Ok(self
            .internal
            .map_materialize(&co_id, &pending)
            .map_err(to_wasm_err)? as f64)
    }

    /// Boundary (a): latest JSON value for `key`, or undefined.
    #[wasm_bindgen(js_name = mapGet)]
    pub fn map_get(&self, co_id: String, key: String) -> Result<Option<String>, JsValue> {
        self.internal.map_get(&co_id, &key).map_err(to_wasm_err)
    }

    /// Boundary (a): JSON value for `key` at `at_time` (ms; omit for latest).
    #[wasm_bindgen(js_name = mapGetAt)]
    pub fn map_get_at(
        &self,
        co_id: String,
        key: String,
        at_time: Option<f64>,
    ) -> Result<Option<String>, JsValue> {
        self.internal
            .map_get_at(&co_id, &key, at_time.map(|v| v as u64))
            .map_err(to_wasm_err)
    }

    /// Boundary (b): whole materialized map as a JSON object string.
    #[wasm_bindgen(js_name = mapSnapshot)]
    pub fn map_snapshot(&self, co_id: String) -> Result<String, JsValue> {
        self.internal.map_snapshot(&co_id).map_err(to_wasm_err)
    }

    /// Boundary (c): `{version, changedKeys, deletedKeys}` since `since_version`.
    #[wasm_bindgen(js_name = mapDelta)]
    pub fn map_delta(&self, co_id: String, since_version: f64) -> Result<String, JsValue> {
        self.internal
            .map_delta(&co_id, since_version as u64)
            .map_err(to_wasm_err)
    }

    /// Boundary (c-rich): `{version, reset, changedKeys}` since `since_version`,
    /// each `changedKeys[k]` the full `MapOp[]` op-list — the payload a TS
    /// `RawCoMap` rebuilds `ops`/`latest` from.
    #[wasm_bindgen(js_name = mapDeltaRich)]
    pub fn map_delta_rich(&self, co_id: String, since_version: f64) -> Result<String, JsValue> {
        self.internal
            .map_delta_rich(&co_id, since_version as u64)
            .map_err(to_wasm_err)
    }

    /// Frontier read: latest frontier-visible value of `key` (undefined =
    /// absent). `frontier_json` is `{ sessionID: txCount }`.
    #[wasm_bindgen(js_name = mapGetAtFrontier)]
    pub fn map_get_at_frontier(
        &self,
        co_id: String,
        key: String,
        frontier_json: String,
    ) -> Result<Option<String>, JsValue> {
        self.internal
            .map_get_at_frontier(&co_id, &key, &frontier_json)
            .map_err(to_wasm_err)
    }

    /// Frontier read: whole `{key: latestVisibleValue}` snapshot under
    /// `frontier_json` as a JSON object string.
    #[wasm_bindgen(js_name = mapSnapshotAtFrontier)]
    pub fn map_snapshot_at_frontier(
        &self,
        co_id: String,
        frontier_json: String,
    ) -> Result<String, JsValue> {
        self.internal
            .map_snapshot_at_frontier(&co_id, &frontier_json)
            .map_err(to_wasm_err)
    }

    /// R3 stage-1 single-call ingest: add a content chunk's transactions, validate
    /// them in-crate, and materialize the coMap view in ONE crossing — returning
    /// only the compact `IngestOutcomeWire` (`{generation, count, viewVersion,
    /// deltaJson}`), with no per-transaction verdict array. The raw session log is
    /// still written, so TS sync/storage are unaffected. See
    /// `NodeCore::ingest_and_materialize`.
    #[wasm_bindgen(js_name = ingestAndMaterialize)]
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
        pending: JsValue,
    ) -> Result<JsValue, JsValue> {
        let pending: Vec<PendingTxWire> = serde_wasm_bindgen::from_value(pending)
            .map_err(|e| to_wasm_err(CojsonCoreWasmError::from(e)))?;
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
                &pending_wire_to_rust(pending),
            )
            .map_err(to_wasm_err)?;
        Ok(serialize_js_value(IngestOutcomeWire::from(out)))
    }

    // === R1 key store (experimental) ===

    /// Feed a resolved `KeyID -> KeySecret` to the native key store (idempotent).
    #[wasm_bindgen(js_name = provideKeySecret)]
    pub fn provide_key_secret(&mut self, key_id: String, key_secret: String) {
        self.internal.provide_key_secret(&key_id, &key_secret);
    }

    /// Whether a secret for `key_id` has been provided.
    #[wasm_bindgen(js_name = hasKeySecret)]
    pub fn has_key_secret(&self, key_id: String) -> bool {
        self.internal.has_key_secret(&key_id)
    }

    /// The `KeyID`s `co_id`'s materialized view still needs a secret for.
    #[wasm_bindgen(js_name = missingKeyIds)]
    pub fn missing_key_ids(&self, co_id: String) -> Vec<String> {
        self.internal.missing_key_ids(&co_id)
    }
}
