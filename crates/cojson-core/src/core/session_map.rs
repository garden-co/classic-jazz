//! SessionMap implementation - one instance per CoValue
//!
//! This module provides the `SessionMapImpl` struct which owns all session data
//! for a single CoValue, including the header, sessions, and known state tracking.

use crate::core::keys::{CoID, KeyID, KeySecret, Signature, SignerID, SignerSecret};
use crate::core::session_log::{SessionID, SessionLogInternal, Transaction, TransactionMode};
use crate::core::CoJsonCoreError;
use indexmap::IndexMap;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

/// Result of creating a new transaction, containing the signature and transaction data
#[derive(Debug, Clone)]
pub struct SignedTransaction {
    pub signature: Signature,
    pub transaction: Transaction,
}

/// SessionMap implementation - one instance per CoValue
/// Owns the header and all session data for a single CoValue
#[derive(Debug)]
pub struct SessionMapImpl {
    co_id: CoID,
    header: CoValueHeader,
    /// Using IndexMap to preserve session insertion order (matches TypeScript Map behavior)
    sessions: IndexMap<String, SessionLogInternal>,
    known_state: KnownState,
    known_state_with_streaming: Option<KnownState>,
    streaming_known_state: Option<KnownStateSessions>,
    is_deleted: bool,
    /// Max recommended transaction size threshold for in-between signatures
    /// Matches TRANSACTION_CONFIG.MAX_RECOMMENDED_TX_SIZE from TypeScript
    max_tx_size: usize,
}

// ============================================================================
// Header Types
// ============================================================================

/// Custom JSON value type with stable (sorted) object key ordering
/// This ensures serialization matches TypeScript's stableStringify
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(untagged)]
pub enum JsonValue {
    Null,
    Bool(bool),
    Number(serde_json::Number),
    String(String),
    Array(Vec<JsonValue>),
    Object(BTreeMap<String, JsonValue>), // Sorted keys!
}

/// Nullable string field that can be:
/// - Missing (None) - skipped during serialization
/// - Present as null - serialized as `null`
/// - Present as a string - serialized as `"..."`
///
/// This is needed because TypeScript's `createdAt?: string | null` can be:
/// - undefined (missing from JSON)
/// - null (explicitly null)
/// - a string
#[derive(Clone, Debug, PartialEq)]
pub enum NullableString {
    Missing,
    Null,
    Value(String),
}

impl Serialize for NullableString {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        match self {
            NullableString::Missing => {
                // This shouldn't happen if skip_serializing_if is used correctly
                serializer.serialize_none()
            }
            NullableString::Null => serializer.serialize_none(),
            NullableString::Value(s) => serializer.serialize_str(s),
        }
    }
}

impl<'de> Deserialize<'de> for NullableString {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        // This is called when the field IS present in JSON
        // If it's null, we get None from Option<String>::deserialize
        // If it's a string, we get Some(string)
        let value: Option<String> = Option::deserialize(deserializer)?;
        match value {
            None => Ok(NullableString::Null),
            Some(s) => Ok(NullableString::Value(s)),
        }
    }
}

impl NullableString {
    fn is_missing(&self) -> bool {
        matches!(self, NullableString::Missing)
    }
}

impl Default for NullableString {
    fn default() -> Self {
        NullableString::Missing
    }
}

/// Header matching TypeScript CoValueHeader
/// CRITICAL: Fields MUST be in alphabetical order to match stableStringify!
/// serde serializes struct fields in definition order.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct CoValueHeader {
    // Fields in alphabetical order: createdAt, meta, ruleset, type, uniqueness
    #[serde(
        rename = "createdAt",
        skip_serializing_if = "NullableString::is_missing",
        default
    )]
    pub created_at: NullableString,
    pub meta: Option<JsonValue>,
    pub ruleset: RulesetDef,
    #[serde(rename = "type")]
    pub co_type: String, // "comap" | "colist" | "costream" | "coplaintext"
    pub uniqueness: Uniqueness,
}

/// RulesetDef - NOT using serde(tag) because it puts tag first, not alphabetically
/// Instead, we manually include the "type" field in alphabetical position
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(untagged)]
pub enum RulesetDef {
    Group(RulesetGroup),
    OwnedByGroup(RulesetOwnedByGroup),
    UnsafeAllowAll(RulesetUnsafeAllowAll),
}

/// {"initialAdmin": "...", "type": "group"} - fields in alphabetical order
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct RulesetGroup {
    #[serde(rename = "initialAdmin")]
    pub initial_admin: String,
    #[serde(rename = "type")]
    pub ruleset_type: RulesetGroupType,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub enum RulesetGroupType {
    #[serde(rename = "group")]
    Group,
}

/// {"group": "...", "restrictDeletion": true, "type": "ownedByGroup"} - fields in alphabetical order
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct RulesetOwnedByGroup {
    pub group: String,
    #[serde(
        rename = "restrictDeletion",
        skip_serializing_if = "Option::is_none",
        default
    )]
    pub restrict_deletion: Option<bool>,
    #[serde(rename = "type")]
    pub ruleset_type: RulesetOwnedByGroupType,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub enum RulesetOwnedByGroupType {
    #[serde(rename = "ownedByGroup")]
    OwnedByGroup,
}

/// {"type": "unsafeAllowAll"} - only has type field
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct RulesetUnsafeAllowAll {
    #[serde(rename = "type")]
    pub ruleset_type: RulesetUnsafeAllowAllType,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub enum RulesetUnsafeAllowAllType {
    #[serde(rename = "unsafeAllowAll")]
    UnsafeAllowAll,
}

// Helper constructors for ergonomic RulesetDef creation
impl RulesetDef {
    pub fn group(initial_admin: impl Into<String>) -> Self {
        RulesetDef::Group(RulesetGroup {
            initial_admin: initial_admin.into(),
            ruleset_type: RulesetGroupType::Group,
        })
    }

    pub fn owned_by_group(group: impl Into<String>) -> Self {
        RulesetDef::OwnedByGroup(RulesetOwnedByGroup {
            group: group.into(),
            restrict_deletion: None,
            ruleset_type: RulesetOwnedByGroupType::OwnedByGroup,
        })
    }

    pub fn unsafe_allow_all() -> Self {
        RulesetDef::UnsafeAllowAll(RulesetUnsafeAllowAll {
            ruleset_type: RulesetUnsafeAllowAllType::UnsafeAllowAll,
        })
    }
}

/// Uniqueness type - Object variant uses BTreeMap for stable serialization
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(untagged)]
pub enum Uniqueness {
    String(String),
    Bool(bool),
    Integer(i64),
    Null,
    Object(BTreeMap<String, String>), // BTreeMap for stable key ordering!
}

// ============================================================================
// Known State Types
// ============================================================================

/// KnownState - fields in alphabetical order, uses BTreeMap for sessions
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct KnownState {
    // Alphabetical order: header, id, sessions
    pub header: bool,
    pub id: String,
    pub sessions: IndexMap<String, u32>, // BTreeMap for stable ordering!
}

/// KnownStateSessions - uses BTreeMap for stable serialization
pub type KnownStateSessions = IndexMap<String, u32>;

// ============================================================================
// Error Types
// ============================================================================

#[derive(Debug, thiserror::Error)]
pub enum SessionMapError {
    #[error("Invalid transaction: {0}")]
    InvalidTransaction(String),

    #[error("Session not found: {0}")]
    SessionNotFound(String),

    #[error("Invalid header JSON: {0}")]
    InvalidHeader(String),

    #[error("Invalid uniqueness: {0}")]
    InvalidUniqueness(String),

    #[error("CoValue ID mismatch: expected {expected}, got {actual}")]
    IdMismatch { expected: String, actual: String },

    #[error("Cannot add to deleted CoValue: {0}")]
    DeletedCoValue(String),

    #[error("Unknown CoValue: {0}")]
    UnknownCoValue(String),

    #[error("CoValue not loaded: {0}")]
    CoValueNotLoaded(String),

    #[error("Serialization error: {0}")]
    Serialization(#[from] serde_json::Error),

    #[error("Core error: {0}")]
    Core(#[from] CoJsonCoreError),
}

// ============================================================================
// Header Validation
// ============================================================================

/// Validate the uniqueness field of a header.
/// Returns Ok(()) if valid, Err with message if invalid.
fn validate_uniqueness(uniqueness: &Uniqueness) -> Result<(), SessionMapError> {
    match uniqueness {
        Uniqueness::String(_) | Uniqueness::Bool(_) | Uniqueness::Null => Ok(()),
        Uniqueness::Integer(_) => {
            // Integers are allowed (TS allows integers but not floats, Rust i64 is always integer)
            Ok(())
        }
        Uniqueness::Object(map) => {
            // Object values must all be strings - already enforced by BTreeMap<String, String>
            // But we validate the map is not empty or has valid structure
            for (key, _value) in map {
                if key.is_empty() {
                    return Err(SessionMapError::InvalidUniqueness(
                        "Object keys cannot be empty".to_string(),
                    ));
                }
            }
            Ok(())
        }
    }
}

/// Compute the expected CoValue ID from a header.
/// This mirrors TypeScript's `idforHeader` function:
/// 1. Serialize header to stable JSON (sorted keys)
/// 2. BLAKE3 hash the JSON bytes
/// 3. Take first 19 bytes, base58 encode
/// 4. Prefix with "co_z"
fn compute_co_id_from_header(header: &CoValueHeader) -> Result<String, SessionMapError> {
    // Serialize header to JSON - serde_json with BTreeMap gives sorted keys
    let header_json = serde_json::to_string(header)?;

    Ok(crate::hash::blake3::short_hash_with_prefix(
        header_json.as_bytes(),
        "co_z",
    ))
}

// ============================================================================
// SessionMapImpl Implementation
// ============================================================================

impl SessionMapImpl {
    /// Default max transaction size (100KB) - matches TypeScript default
    pub const DEFAULT_MAX_TX_SIZE: usize = 100 * 1024;

    /// Create a new SessionMap for a CoValue.
    /// Validates the header and verifies that `co_id` matches the hash of the header.
    /// `max_tx_size` is the threshold for recording in-between signatures (default: 100KB)
    pub fn new(
        co_id: &str,
        header_json: &str,
        max_tx_size: Option<u32>,
    ) -> Result<Self, SessionMapError> {
        Self::new_internal(co_id, header_json, max_tx_size, false)
    }

    /// Create a new SessionMap for a CoValue, optionally skipping validation.
    /// When `skip_verify` is true, uniqueness and ID validation are skipped.
    /// This is used for storage shards where we trust the data.
    pub fn new_with_skip_verify(
        co_id: &str,
        header_json: &str,
        max_tx_size: Option<u32>,
        skip_verify: bool,
    ) -> Result<Self, SessionMapError> {
        Self::new_internal(co_id, header_json, max_tx_size, skip_verify)
    }

    fn new_internal(
        co_id: &str,
        header_json: &str,
        max_tx_size: Option<u32>,
        skip_verify: bool,
    ) -> Result<Self, SessionMapError> {
        // Parse the header JSON
        let header: CoValueHeader = serde_json::from_str(header_json)
            .map_err(|e| SessionMapError::InvalidHeader(e.to_string()))?;

        if !skip_verify {
            // Validate uniqueness
            validate_uniqueness(&header.uniqueness)?;

            // Verify co_id matches the header hash
            let expected_id = compute_co_id_from_header(&header)?;
            if co_id != expected_id {
                return Err(SessionMapError::IdMismatch {
                    expected: expected_id,
                    actual: co_id.to_string(),
                });
            }
        }

        Ok(Self {
            co_id: CoID(co_id.to_string()),
            header,
            sessions: IndexMap::new(),
            known_state: KnownState {
                header: true,
                id: co_id.to_string(),
                sessions: IndexMap::new(), // maybe this should be a indexMap in the future.
            },
            known_state_with_streaming: None,
            streaming_known_state: None,
            is_deleted: false,
            max_tx_size: max_tx_size
                .map(|s| s as usize)
                .unwrap_or(Self::DEFAULT_MAX_TX_SIZE),
        })
    }

    // === Header ===

    /// Get the header as JSON
    pub fn get_header(&self) -> String {
        serde_json::to_string(&self.header).expect("header serialization should not fail")
    }

    /// Borrow the parsed header. Used by the group engine to read ruleset facts
    /// (kind, `initialAdmin`) and the `meta.type == "account"` marker without
    /// re-serializing/parsing the header JSON on every access.
    pub(crate) fn header(&self) -> &CoValueHeader {
        &self.header
    }

    // === Transaction Operations ===

    /// Add transactions to a session
    pub fn add_transactions(
        &mut self,
        session_id: &str,
        signer_id: Option<&str>,
        transactions_json: &str,
        signature: &str,
        skip_verify: bool,
    ) -> Result<(), SessionMapError> {
        if self.is_deleted && !is_delete_session_id(session_id) {
            return Err(SessionMapError::DeletedCoValue(self.co_id.0.clone()));
        }

        let transactions: Vec<Transaction> = serde_json::from_str(transactions_json)?;

        // Get or create session log
        let session_log = self
            .sessions
            .entry(session_id.to_string())
            .or_insert_with(|| {
                SessionLogInternal::new(
                    self.co_id.clone(),
                    SessionID(session_id.to_string()),
                    signer_id.map(|s| SignerID(s.to_string())),
                )
            });

        // Calculate size of transactions being added (for in-between signature tracking)
        let mut total_size: usize = 0;
        for tx in &transactions {
            let tx_size = match tx {
                Transaction::Private(private_tx) => private_tx.encrypted_changes.value.len(),
                Transaction::Trusting(trusting_tx) => trusting_tx.changes.len(),
            };
            total_size += tx_size;
        }

        // Add transactions to staging area
        for tx in transactions.into_iter() {
            match tx {
                Transaction::Private(private_tx) => {
                    session_log.add_existing_private_transaction(
                        private_tx.encrypted_changes.value,
                        private_tx.key_used.0,
                        private_tx.made_at.as_u64().map_or_else(
                            || {
                                Err(SessionMapError::InvalidTransaction(
                                    "Failed to convert made_at to u64".to_string(),
                                ))
                            },
                            |u| Ok(u),
                        )?,
                        private_tx.meta.map(|m| m.value),
                    )?;
                }
                Transaction::Trusting(trusting_tx) => {
                    session_log.add_existing_trusting_transaction(
                        trusting_tx.changes,
                        trusting_tx.made_at.as_u64().map_or_else(
                            || {
                                Err(SessionMapError::InvalidTransaction(
                                    "Failed to convert made_at to u64".to_string(),
                                ))
                            },
                            |u| Ok(u),
                        )?,
                        trusting_tx.meta,
                    )?;
                }
            }
        }

        // Commit transactions with signature verification
        let sig = Signature(signature.to_string());
        session_log.commit_transactions(&sig, skip_verify)?;

        // Track size for in-between signatures
        session_log.add_to_size_tracking(total_size);

        // Record in-between signature if size exceeds threshold
        let tx_count = session_log.transactions_json().len() as u32;
        if session_log.cumulative_tx_size() > self.max_tx_size && tx_count > 0 {
            session_log.record_inbetween_signature(tx_count - 1, signature.to_string());
        }

        // Update known state
        self.known_state
            .sessions
            .insert(session_id.to_string(), tx_count);

        // Check if streaming state is now satisfied
        if let Some(streaming) = &self.streaming_known_state {
            if is_known_state_subset_of(streaming, &self.known_state.sessions) {
                self.streaming_known_state = None;
                self.known_state_with_streaming = None;
            }
        }

        // Update known_state_with_streaming if present
        if let Some(ref mut ks_streaming) = self.known_state_with_streaming {
            ks_streaming
                .sessions
                .entry(session_id.to_string())
                .and_modify(|c| *c = (*c).max(tx_count))
                .or_insert(tx_count);
        }

        Ok(())
    }

    /// Create new private transaction (for local writes)
    /// Returns the signature and transaction data
    pub fn make_new_private_transaction(
        &mut self,
        session_id: String,
        signer_secret: String,
        changes_json: &str,
        key_id: String,
        key_secret: String,
        meta_json: Option<String>,
        made_at: u64,
    ) -> Result<SignedTransaction, SessionMapError> {
        if self.is_deleted {
            return Err(SessionMapError::DeletedCoValue(self.co_id.0.clone()));
        }

        // Clone session_id once for reuse (used in entry key, SessionID, and known_state inserts)
        let session_id_for_state = session_id.clone();

        // Get or create session log
        let session_log = self.sessions.entry(session_id.clone()).or_insert_with(|| {
            SessionLogInternal::new(
                self.co_id.clone(),
                SessionID(session_id),
                None, // signerID derived from secret
            )
        });

        // Add new transaction
        let (signature, transaction) = session_log.add_new_transaction(
            changes_json,
            TransactionMode::Private {
                key_id: KeyID(key_id),
                key_secret: KeySecret(key_secret),
            },
            &SignerSecret(signer_secret),
            made_at,
            meta_json,
        )?;

        // Track size for in-between signatures (use encrypted changes length)
        let tx_size = match &transaction {
            Transaction::Private(p) => p.encrypted_changes.value.len(),
            Transaction::Trusting(t) => t.changes.len(),
        };
        session_log.add_to_size_tracking(tx_size);

        // Update known state
        let tx_count = session_log.transactions_json().len() as u32;

        // Record in-between signature if size exceeds threshold
        if session_log.cumulative_tx_size() > self.max_tx_size && tx_count > 0 {
            session_log.record_inbetween_signature(tx_count - 1, signature.0.clone());
        }

        self.known_state
            .sessions
            .insert(session_id_for_state.clone(), tx_count);

        // Update known_state_with_streaming if present
        if let Some(ref mut ks_streaming) = self.known_state_with_streaming {
            ks_streaming.sessions.insert(session_id_for_state, tx_count);
        }

        Ok(SignedTransaction {
            signature,
            transaction,
        })
    }

    /// Create new trusting transaction (for local writes)
    /// Returns the signature and transaction data
    pub fn make_new_trusting_transaction(
        &mut self,
        session_id: String,
        signer_secret: String,
        changes_json: &str,
        meta_json: Option<String>,
        made_at: u64,
    ) -> Result<SignedTransaction, SessionMapError> {
        if self.is_deleted {
            return Err(SessionMapError::DeletedCoValue(self.co_id.0.clone()));
        }

        // Clone session_id once for reuse (used in entry key, SessionID, and known_state inserts)
        let session_id_for_state = session_id.clone();

        // Get or create session log
        let session_log = self.sessions.entry(session_id.clone()).or_insert_with(|| {
            SessionLogInternal::new(
                self.co_id.clone(),
                SessionID(session_id),
                None, // signerID derived from secret
            )
        });

        // Add new transaction
        let (signature, transaction) = session_log.add_new_transaction(
            changes_json,
            TransactionMode::Trusting,
            &SignerSecret(signer_secret),
            made_at,
            meta_json,
        )?;

        // Track size for in-between signatures
        let tx_size = match &transaction {
            Transaction::Private(p) => p.encrypted_changes.value.len(),
            Transaction::Trusting(t) => t.changes.len(),
        };
        session_log.add_to_size_tracking(tx_size);

        // Update known state
        let tx_count = session_log.transactions_json().len() as u32;

        // Record in-between signature if size exceeds threshold
        if session_log.cumulative_tx_size() > self.max_tx_size && tx_count > 0 {
            session_log.record_inbetween_signature(tx_count - 1, signature.0.clone());
        }

        self.known_state
            .sessions
            .insert(session_id_for_state.clone(), tx_count);

        // Update known_state_with_streaming if present
        if let Some(ref mut ks_streaming) = self.known_state_with_streaming {
            ks_streaming.sessions.insert(session_id_for_state, tx_count);
        }

        Ok(SignedTransaction {
            signature,
            transaction,
        })
    }

    // === Session Queries ===

    /// Get all session IDs
    pub fn get_session_ids(&self) -> Vec<String> {
        self.sessions.keys().cloned().collect()
    }

    /// Get transaction count for a session (None if session not found)
    pub fn get_transaction_count(&self, session_id: &str) -> Option<u32> {
        self.sessions
            .get(session_id)
            .map(|sl| sl.transactions_json().len() as u32)
    }

    /// Get single transaction by index
    pub fn get_transaction(&self, session_id: &str, tx_index: u32) -> Option<String> {
        self.sessions
            .get(session_id)
            .and_then(|sl| sl.transactions_json().get(tx_index as usize))
            .cloned()
    }

    /// Get transactions for a session from index
    pub fn get_session_transactions(
        &self,
        session_id: &str,
        from_index: u32,
    ) -> Option<Vec<String>> {
        let session_log = self.sessions.get(session_id)?;
        let transactions = session_log.transactions_json();

        Some(
            transactions
                .iter()
                .skip(from_index as usize)
                .cloned()
                .collect(),
        )
    }

    /// Iterate every session in insertion order, yielding `(session_id, raw tx JSON)`
    /// by reference — no cloning of session ids or transaction strings.
    ///
    /// Used by the group engine (`collect_group_txs`) to build transaction views
    /// straight from stored state without copying whole session logs. The session
    /// order matches TypeScript `Map` insertion order (this is an `IndexMap`).
    pub(crate) fn iter_session_transactions(&self) -> impl Iterator<Item = (&str, &[String])> {
        self.sessions
            .iter()
            .map(|(sid, log)| (sid.as_str(), log.transactions_json().as_slice()))
    }

    /// Get last signature for a session
    pub fn get_last_signature(&self, session_id: &str) -> Option<String> {
        self.sessions
            .get(session_id)
            .and_then(|sl| sl.last_signature())
            .map(|s| s.0.clone())
    }

    /// Get signature after specific transaction index
    pub fn get_signature_after(&self, session_id: &str, tx_index: u32) -> Option<String> {
        self.sessions
            .get(session_id)
            .and_then(|sl| sl.get_signature_after(tx_index))
            .map(|s| s.to_string())
    }

    /// Get the last signature checkpoint index (max index in signatureAfter map, or -1 if no checkpoints)
    pub fn get_last_signature_checkpoint(&self, session_id: &str) -> Option<i32> {
        self.sessions
            .get(session_id)
            .map(|sl| sl.get_last_signature_checkpoint())
    }

    // === Known State ===

    /// Get the known state as a native struct
    pub fn get_known_state(&self) -> &KnownState {
        &self.known_state
    }

    /// Get the known state with streaming as a native struct
    pub fn get_known_state_with_streaming(&self) -> Option<&KnownState> {
        self.known_state_with_streaming.as_ref()
    }

    /// Check whether the CoValue still has pending streaming content.
    pub fn is_streaming(&self) -> bool {
        self.known_state_with_streaming.is_some()
    }

    /// Set streaming known state
    pub fn set_streaming_known_state(
        &mut self,
        streaming_json: &str,
    ) -> Result<(), SessionMapError> {
        if self.is_deleted {
            return Ok(());
        }

        let streaming: KnownStateSessions = serde_json::from_str(streaming_json)?;

        // Check if streaming state is subset of current known state
        if is_known_state_subset_of(&streaming, &self.known_state.sessions) {
            return Ok(()); // Already have this data
        }

        // Get the actual streaming known state (what we don't have yet)
        let actual_streaming = get_known_state_to_send(&streaming, &self.known_state.sessions);

        // Update or create streaming_known_state
        if let Some(ref mut current) = self.streaming_known_state {
            combine_known_state_sessions(current, &actual_streaming);
        } else {
            self.streaming_known_state = Some(actual_streaming.clone());
        }

        // Update known_state_with_streaming
        if self.known_state_with_streaming.is_none() {
            self.known_state_with_streaming = Some(self.known_state.clone());
        }

        if let Some(ref mut ks_streaming) = self.known_state_with_streaming {
            combine_known_state_sessions(&mut ks_streaming.sessions, &actual_streaming);
        }

        Ok(())
    }

    // === Deletion ===

    /// Mark this CoValue as deleted
    pub fn mark_as_deleted(&mut self) {
        self.is_deleted = true;

        // Reset known state to only report delete sessions
        let mut new_known_state = KnownState {
            header: true,
            id: self.co_id.0.clone(),
            sessions: IndexMap::new(),
        };

        // Only keep delete session counts in known state
        for (session_id, session_log) in &self.sessions {
            if is_delete_session_id(session_id) {
                new_known_state.sessions.insert(
                    session_id.clone(),
                    session_log.transactions_json().len() as u32,
                );
            }
        }

        self.known_state = new_known_state;
        self.known_state_with_streaming = None;
        self.streaming_known_state = None;
    }

    /// Check if this CoValue is deleted
    pub fn is_deleted(&self) -> bool {
        self.is_deleted
    }

    // === Decryption ===

    /// Decrypt transaction changes (returns None if session not found)
    pub fn decrypt_transaction(
        &self,
        session_id: &str,
        tx_index: u32,
        key_secret: &str,
    ) -> Result<Option<String>, SessionMapError> {
        let session_log = match self.sessions.get(session_id) {
            Some(log) => log,
            None => return Ok(None),
        };

        let decrypted = session_log
            .decrypt_next_transaction_changes_json(tx_index, KeySecret(key_secret.to_string()))?;
        Ok(Some(decrypted))
    }

    /// Decrypt transaction meta (returns None if session not found)
    pub fn decrypt_transaction_meta(
        &self,
        session_id: &str,
        tx_index: u32,
        key_secret: &str,
    ) -> Result<Option<String>, SessionMapError> {
        let session_log = match self.sessions.get(session_id) {
            Some(log) => log,
            None => return Ok(None),
        };

        Ok(session_log
            .decrypt_next_transaction_meta_json(tx_index, KeySecret(key_secret.to_string()))?)
    }
}

// ============================================================================
// Helper Functions
// ============================================================================

/// Check if session ID is a delete session
fn is_delete_session_id(session_id: &str) -> bool {
    session_id.contains("_session_d") && session_id.ends_with('$')
}

/// Check if streaming state is a subset of current state
fn is_known_state_subset_of(streaming: &KnownStateSessions, current: &KnownStateSessions) -> bool {
    streaming.iter().all(|(session_id, &count)| {
        current
            .get(session_id)
            .map(|&current_count| count <= current_count)
            .unwrap_or(false)
    })
}

/// Get the known state to send (what the peer doesn't have)
fn get_known_state_to_send(
    streaming: &KnownStateSessions,
    current: &KnownStateSessions,
) -> KnownStateSessions {
    streaming
        .iter()
        .filter_map(|(session_id, &count)| {
            let current_count = current.get(session_id).copied().unwrap_or(0);
            if count > current_count {
                Some((session_id.clone(), count))
            } else {
                None
            }
        })
        .collect()
}

/// Combine known state sessions (max of each session)
fn combine_known_state_sessions(target: &mut KnownStateSessions, source: &KnownStateSessions) {
    for (session_id, &count) in source {
        target
            .entry(session_id.clone())
            .and_modify(|c| *c = (*c).max(count))
            .or_insert(count);
    }
}

// ============================================================================
// Tests
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;

    const TEST_HEADER: &str =
        r#"{"meta":null,"ruleset":{"type":"unsafeAllowAll"},"type":"comap","uniqueness":"test"}"#;

    /// Helper to create a session map without validation (for tests that don't care about id matching)
    fn create_test_session_map(co_id: &str, header_json: &str) -> SessionMapImpl {
        SessionMapImpl::new_with_skip_verify(co_id, header_json, None, true).unwrap()
    }

    #[test]
    fn test_session_map_creation() {
        let session_map = create_test_session_map("co_test", TEST_HEADER);

        assert_eq!(session_map.co_id.0, "co_test");
        assert!(!session_map.is_deleted());
        assert!(session_map.get_session_ids().is_empty());
    }

    #[test]
    fn test_header_round_trip() {
        let session_map = create_test_session_map("co_test", TEST_HEADER);

        let header_json = session_map.get_header();
        // Parse back to verify
        let header: CoValueHeader = serde_json::from_str(&header_json).unwrap();
        assert_eq!(header.co_type, "comap");
    }

    #[test]
    fn test_known_state() {
        let session_map = create_test_session_map("co_test", TEST_HEADER);

        let known_state = session_map.get_known_state();

        assert!(known_state.header);
        assert_eq!(known_state.id, "co_test");
        assert!(known_state.sessions.is_empty());
    }

    #[test]
    fn test_mark_as_deleted() {
        let mut session_map = create_test_session_map("co_test", TEST_HEADER);

        session_map.mark_as_deleted();
        assert!(session_map.is_deleted());
    }

    #[test]
    fn test_ruleset_serialization() {
        // Test unsafeAllowAll
        let ruleset = RulesetDef::unsafe_allow_all();
        let json = serde_json::to_string(&ruleset).unwrap();
        assert_eq!(json, r#"{"type":"unsafeAllowAll"}"#);

        // Test group
        let ruleset = RulesetDef::group("co_admin123");
        let json = serde_json::to_string(&ruleset).unwrap();
        // Fields should be in alphabetical order: initialAdmin, type
        assert_eq!(json, r#"{"initialAdmin":"co_admin123","type":"group"}"#);

        // Test ownedByGroup
        let ruleset = RulesetDef::owned_by_group("co_group123");
        let json = serde_json::to_string(&ruleset).unwrap();
        // Fields should be in alphabetical order: group, type
        assert_eq!(json, r#"{"group":"co_group123","type":"ownedByGroup"}"#);

        let restricted_ruleset = RulesetDef::OwnedByGroup(RulesetOwnedByGroup {
            group: "co_group123".to_string(),
            restrict_deletion: Some(true),
            ruleset_type: RulesetOwnedByGroupType::OwnedByGroup,
        });
        let restricted_json = serde_json::to_string(&restricted_ruleset).unwrap();
        // Fields should be in alphabetical order: group, restrictDeletion, type
        assert_eq!(
            restricted_json,
            r#"{"group":"co_group123","restrictDeletion":true,"type":"ownedByGroup"}"#
        );
    }

    #[test]
    fn test_header_serialization_alphabetical_order() {
        let header = CoValueHeader {
            created_at: NullableString::Missing,
            meta: None,
            ruleset: RulesetDef::unsafe_allow_all(),
            co_type: "comap".to_string(),
            uniqueness: Uniqueness::String("test".to_string()),
        };

        let json = serde_json::to_string(&header).unwrap();
        // Fields should be in alphabetical order: meta, ruleset, type, uniqueness
        // (createdAt is skipped because it's Missing)
        assert_eq!(
            json,
            r#"{"meta":null,"ruleset":{"type":"unsafeAllowAll"},"type":"comap","uniqueness":"test"}"#
        );
    }

    #[test]
    fn test_is_delete_session_id() {
        assert!(is_delete_session_id("co_test_session_dabc123$"));
        assert!(!is_delete_session_id("co_test_session_zabc123"));
        assert!(!is_delete_session_id("co_test_session_dabc123")); // missing $
    }

    // ========================================================================
    // Header Serialization Tests (verifying serde matches stableStringify)
    // ========================================================================

    #[test]
    fn test_serde_roundtrip_preserves_json() {
        // This JSON is what TypeScript's stableStringify produces
        // Keys are in alphabetical order
        let ts_json = r#"{"meta":null,"ruleset":{"type":"unsafeAllowAll"},"type":"comap","uniqueness":"test"}"#;

        // Parse and re-serialize
        let header: CoValueHeader = serde_json::from_str(ts_json).unwrap();
        let rust_json = serde_json::to_string(&header).unwrap();

        // They should be identical
        assert_eq!(
            ts_json, rust_json,
            "\nTypeScript stableStringify: {}\nRust serde:                 {}",
            ts_json, rust_json
        );
    }

    #[test]
    fn test_serde_roundtrip_with_created_at() {
        let ts_json = r#"{"createdAt":"2024-01-01T00:00:00.000Z","meta":null,"ruleset":{"type":"unsafeAllowAll"},"type":"comap","uniqueness":"test"}"#;

        let header: CoValueHeader = serde_json::from_str(ts_json).unwrap();
        let rust_json = serde_json::to_string(&header).unwrap();

        assert_eq!(
            ts_json, rust_json,
            "\nTypeScript stableStringify: {}\nRust serde:                 {}",
            ts_json, rust_json
        );
    }

    #[test]
    fn test_serde_roundtrip_with_group_ruleset() {
        let ts_json = r#"{"meta":null,"ruleset":{"initialAdmin":"co_zadmin123","type":"group"},"type":"comap","uniqueness":"zABC123"}"#;

        let header: CoValueHeader = serde_json::from_str(ts_json).unwrap();
        let rust_json = serde_json::to_string(&header).unwrap();

        assert_eq!(
            ts_json, rust_json,
            "\nTypeScript stableStringify: {}\nRust serde:                 {}",
            ts_json, rust_json
        );
    }

    #[test]
    fn test_serde_roundtrip_realistic_account_header() {
        // This is what TypeScript produces for a real account header
        // Fields: createdAt, meta, ruleset (with initialAdmin + type), type, uniqueness
        let ts_json = r#"{"createdAt":"2024-01-15T10:30:00.000Z","meta":null,"ruleset":{"initialAdmin":"co_z8mWmSe2pxfZjL6Vqx5gYy2wX","type":"group"},"type":"comap","uniqueness":"z8mWmSe2pxfZjL6Vqx5gYy2wXabc"}"#;

        let header: CoValueHeader = serde_json::from_str(ts_json).unwrap();
        let rust_json = serde_json::to_string(&header).unwrap();

        assert_eq!(
            ts_json, rust_json,
            "\nTypeScript stableStringify: {}\nRust serde:                 {}",
            ts_json, rust_json
        );
    }

    #[test]
    fn test_id_validation_with_realistic_header() {
        // Create a realistic header and compute its ID
        let header = CoValueHeader {
            created_at: NullableString::Value("2024-01-15T10:30:00.000Z".to_string()),
            meta: Some(JsonValue::Null),
            ruleset: RulesetDef::group("co_z8mWmSe2pxfZjL6Vqx5gYy2wX"),
            co_type: "comap".to_string(),
            uniqueness: Uniqueness::String("z8mWmSe2pxfZjL6Vqx5gYy2wXabc".to_string()),
        };

        let header_json = serde_json::to_string(&header).unwrap();
        let expected_id = compute_co_id_from_header(&header).unwrap();

        println!("Header JSON: {}", header_json);
        println!("Expected ID: {}", expected_id);

        // Validation should succeed
        let result = SessionMapImpl::new(&expected_id, &header_json, None);
        assert!(result.is_ok(), "Failed: {:?}", result.err());
    }

    #[test]
    fn test_created_at_null_handling() {
        // TypeScript can pass "createdAt":null - what happens?
        let ts_json_with_null = r#"{"createdAt":null,"meta":null,"ruleset":{"type":"unsafeAllowAll"},"type":"comap","uniqueness":"test"}"#;

        let header: CoValueHeader = serde_json::from_str(ts_json_with_null).unwrap();
        let rust_json = serde_json::to_string(&header).unwrap();

        println!("Input:  {}", ts_json_with_null);
        println!("Output: {}", rust_json);
        println!("created_at: {:?}", header.created_at);

        assert_eq!(
            ts_json_with_null, rust_json,
            "\nTypeScript passes: {}\nRust produces:     {}",
            ts_json_with_null, rust_json
        );
    }

    #[test]
    fn test_serde_roundtrip_with_owned_by_group_ruleset() {
        let ts_json = r#"{"meta":null,"ruleset":{"group":"co_zgroup123","type":"ownedByGroup"},"type":"colist","uniqueness":"zXYZ789"}"#;

        let header: CoValueHeader = serde_json::from_str(ts_json).unwrap();
        let rust_json = serde_json::to_string(&header).unwrap();

        assert_eq!(
            ts_json, rust_json,
            "\nTypeScript stableStringify: {}\nRust serde:                 {}",
            ts_json, rust_json
        );
    }

    #[test]
    fn test_serde_roundtrip_with_owned_by_group_restricted_deletion_ruleset() {
        let ts_json = r#"{"meta":null,"ruleset":{"group":"co_zgroup123","restrictDeletion":true,"type":"ownedByGroup"},"type":"colist","uniqueness":"zXYZ789"}"#;

        let header: CoValueHeader = serde_json::from_str(ts_json).unwrap();
        let rust_json = serde_json::to_string(&header).unwrap();

        assert_eq!(
            ts_json, rust_json,
            "\nTypeScript stableStringify: {}\nRust serde:                 {}",
            ts_json, rust_json
        );
    }

    #[test]
    fn test_serde_roundtrip_with_nested_meta() {
        // Meta with nested object - keys should be sorted
        let ts_json = r#"{"meta":{"alpha":"first","beta":"second","gamma":{"nested":"value"}},"ruleset":{"type":"unsafeAllowAll"},"type":"comap","uniqueness":"test"}"#;

        let header: CoValueHeader = serde_json::from_str(ts_json).unwrap();
        let rust_json = serde_json::to_string(&header).unwrap();

        assert_eq!(
            ts_json, rust_json,
            "\nTypeScript stableStringify: {}\nRust serde:                 {}",
            ts_json, rust_json
        );
    }

    #[test]
    fn test_serde_roundtrip_with_uniqueness_object() {
        let ts_json = r#"{"meta":null,"ruleset":{"type":"unsafeAllowAll"},"type":"comap","uniqueness":{"key1":"value1","key2":"value2"}}"#;

        let header: CoValueHeader = serde_json::from_str(ts_json).unwrap();
        let rust_json = serde_json::to_string(&header).unwrap();

        assert_eq!(
            ts_json, rust_json,
            "\nTypeScript stableStringify: {}\nRust serde:                 {}",
            ts_json, rust_json
        );
    }

    // ========================================================================
    // Header Validation Tests
    // ========================================================================

    #[test]
    fn test_compute_co_id_from_header() {
        let header = CoValueHeader {
            created_at: NullableString::Missing,
            meta: None,
            ruleset: RulesetDef::unsafe_allow_all(),
            co_type: "comap".to_string(),
            uniqueness: Uniqueness::String("test".to_string()),
        };

        let co_id = compute_co_id_from_header(&header).unwrap();
        assert!(co_id.starts_with("co_z"));
        // The ID should be deterministic
        let co_id2 = compute_co_id_from_header(&header).unwrap();
        assert_eq!(co_id, co_id2);
    }

    #[test]
    fn test_validation_with_matching_id() {
        let header = CoValueHeader {
            created_at: NullableString::Missing,
            meta: None,
            ruleset: RulesetDef::unsafe_allow_all(),
            co_type: "comap".to_string(),
            uniqueness: Uniqueness::String("test".to_string()),
        };

        let header_json = serde_json::to_string(&header).unwrap();
        let expected_id = compute_co_id_from_header(&header).unwrap();

        // Should succeed with matching ID
        let result = SessionMapImpl::new(&expected_id, &header_json, None);
        assert!(result.is_ok());
    }

    #[test]
    fn test_validation_fails_with_mismatched_id() {
        // Should fail with mismatched ID
        let result = SessionMapImpl::new("co_wrong_id", TEST_HEADER, None);
        assert!(result.is_err());

        match result.unwrap_err() {
            SessionMapError::IdMismatch { expected, actual } => {
                assert!(expected.starts_with("co_z"));
                assert_eq!(actual, "co_wrong_id");
            }
            e => panic!("Expected IdMismatch error, got {:?}", e),
        }
    }

    #[test]
    fn test_validation_skip_verify_allows_mismatched_id() {
        // Should succeed with skip_verify = true even with mismatched ID
        let result = SessionMapImpl::new_with_skip_verify("co_wrong_id", TEST_HEADER, None, true);
        assert!(result.is_ok());
    }

    #[test]
    fn test_validate_uniqueness_string() {
        let uniqueness = Uniqueness::String("test".to_string());
        assert!(validate_uniqueness(&uniqueness).is_ok());
    }

    #[test]
    fn test_validate_uniqueness_bool() {
        let uniqueness = Uniqueness::Bool(true);
        assert!(validate_uniqueness(&uniqueness).is_ok());
    }

    #[test]
    fn test_validate_uniqueness_null() {
        let uniqueness = Uniqueness::Null;
        assert!(validate_uniqueness(&uniqueness).is_ok());
    }

    #[test]
    fn test_validate_uniqueness_integer() {
        let uniqueness = Uniqueness::Integer(42);
        assert!(validate_uniqueness(&uniqueness).is_ok());
    }

    #[test]
    fn test_validate_uniqueness_object() {
        let mut map = BTreeMap::new();
        map.insert("key".to_string(), "value".to_string());
        let uniqueness = Uniqueness::Object(map);
        assert!(validate_uniqueness(&uniqueness).is_ok());
    }

    #[test]
    fn test_validate_uniqueness_object_empty_key_rejected() {
        let mut map = BTreeMap::new();
        map.insert("".to_string(), "value".to_string());
        let uniqueness = Uniqueness::Object(map);
        assert!(validate_uniqueness(&uniqueness).is_err());
    }

    #[test]
    fn test_decrypt_transaction_returns_none_for_nonexistent_session() {
        let session_map = create_test_session_map("co_test", TEST_HEADER);

        // Decrypting from a non-existent session should return None, not an error
        let result = session_map.decrypt_transaction(
            "nonexistent_session",
            0,
            "keySecret_z11111111111111111111111111111111",
        );

        assert!(result.is_ok());
        assert!(result.unwrap().is_none());
    }

    #[test]
    fn test_decrypt_transaction_meta_returns_none_for_nonexistent_session() {
        let session_map = create_test_session_map("co_test", TEST_HEADER);

        // Decrypting meta from a non-existent session should return None, not an error
        let result = session_map.decrypt_transaction_meta(
            "nonexistent_session",
            0,
            "keySecret_z11111111111111111111111111111111",
        );

        assert!(result.is_ok());
        assert!(result.unwrap().is_none());
    }
}
