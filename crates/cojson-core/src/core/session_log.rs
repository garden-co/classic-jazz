use crate::core::config::MAX_TX_SIZE_BYTES;
use crate::core::keys::{decode_z, CoID, KeyID, KeySecret, Signature, SignerID, SignerSecret};
use crate::core::{CoJsonCoreError, CryptoCache, NonceGenerator};
use base64::{engine::general_purpose::URL_SAFE, Engine as _};
use ed25519_dalek::{Signer, SigningKey, Verifier, VerifyingKey};
use salsa20::{
    cipher::{Key, KeyIvInit, StreamCipher},
    XSalsa20,
};
use serde::{Deserialize, Serialize};
use serde_json::{Number, Value as JsonValue};
use std::collections::HashMap;

#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct SessionID(pub String);

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TransactionID {
    #[serde(rename = "sessionID")]
    pub session_id: SessionID,
    #[serde(rename = "txIndex")]
    pub tx_index: u32,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(transparent)]
pub struct Encrypted<T> {
    pub value: String,
    _phantom: std::marker::PhantomData<T>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PrivateTransaction {
    #[serde(rename = "encryptedChanges")]
    pub encrypted_changes: Encrypted<JsonValue>,
    #[serde(rename = "keyUsed")]
    pub key_used: KeyID,
    #[serde(rename = "madeAt")]
    pub made_at: Number,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub meta: Option<Encrypted<JsonValue>>,
    pub privacy: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TrustingTransaction {
    pub changes: String,
    #[serde(rename = "madeAt")]
    pub made_at: Number,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub meta: Option<String>,
    pub privacy: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum Transaction {
    Private(PrivateTransaction),
    Trusting(TrustingTransaction),
}

/// Side-table entry describing where the raw encrypted payload(s) live inside a
/// canonical transaction JSON string, so decryption can slice them directly
/// instead of re-parsing the whole transaction.
///
/// A byte range is `(start, end)` into the canonical tx JSON string, pointing at
/// the raw string value WITHOUT the surrounding quotes but INCLUDING the
/// `encrypted_U` prefix. Ranges are only recorded when the value needed no JSON
/// escaping (so the stored bytes equal the logical string). Anything else falls
/// back to `NeedsParse`.
#[derive(Debug, Clone)]
pub enum TxInfo {
    /// Private transaction whose payload(s) can be sliced directly.
    /// `meta` is `Some` only when a meta field is present AND escape-free;
    /// `None` unambiguously means "no meta field" (an escaped meta would have
    /// forced the whole entry to `NeedsParse`).
    Private {
        changes: (u32, u32),
        meta: Option<(u32, u32)>,
    },
    /// Fall back to parsing the tx JSON (trusting txs, or escaped payloads).
    NeedsParse,
}

/// Borrowed mirror of `PrivateTransaction` used purely for canonical
/// serialization. Field order, renames and `skip_serializing_if` MUST match
/// `PrivateTransaction` exactly so output is byte-identical.
#[derive(Serialize)]
struct PrivateTxRef<'a> {
    #[serde(rename = "encryptedChanges")]
    encrypted_changes: &'a str,
    #[serde(rename = "keyUsed")]
    key_used: &'a str,
    #[serde(rename = "madeAt")]
    made_at: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    meta: Option<&'a str>,
    privacy: &'static str,
}

/// Borrowed mirror of `TrustingTransaction` used purely for canonical
/// serialization (byte-identical to `serde_json::to_string(&TrustingTransaction)`).
#[derive(Serialize)]
struct TrustingTxRef<'a> {
    changes: &'a str,
    #[serde(rename = "madeAt")]
    made_at: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    meta: Option<&'a str>,
    privacy: &'static str,
}

/// Return true if serializing `s` as a JSON string would require any escaping.
/// serde_json escapes only control chars (< 0x20), `"` and `\` by default
/// (non-ASCII bytes and `/` are emitted verbatim), so those are the only bytes
/// that make a value non-sliceable.
fn json_needs_escape(s: &str) -> bool {
    s.bytes().any(|b| b < 0x20 || b == b'"' || b == b'\\')
}

/// Build the canonical JSON for a private transaction plus its `TxInfo`.
///
/// When every string field is escape-free the JSON is hand-built (which is
/// byte-identical to `serde_json` for escape-free strings) and payload spans are
/// recorded. Otherwise it falls back to serde serialization and `NeedsParse`.
fn build_private_canonical(
    encrypted_changes: &str,
    key_used: &str,
    made_at: u64,
    meta: Option<&str>,
) -> (String, TxInfo) {
    let escaped = json_needs_escape(encrypted_changes)
        || json_needs_escape(key_used)
        || meta.map(json_needs_escape).unwrap_or(false);

    if escaped {
        let json = serde_json::to_string(&PrivateTxRef {
            encrypted_changes,
            key_used,
            made_at,
            meta,
            privacy: "private",
        })
        .expect("private transaction serialization cannot fail");
        return (json, TxInfo::NeedsParse);
    }

    use std::fmt::Write as _;
    let mut s = String::with_capacity(
        encrypted_changes.len() + key_used.len() + meta.map_or(0, |m| m.len()) + 64,
    );
    s.push_str("{\"encryptedChanges\":\"");
    let changes_start = s.len() as u32;
    s.push_str(encrypted_changes);
    let changes_end = s.len() as u32;
    s.push_str("\",\"keyUsed\":\"");
    s.push_str(key_used);
    s.push_str("\",\"madeAt\":");
    let _ = write!(s, "{}", made_at);
    let meta_span = if let Some(m) = meta {
        s.push_str(",\"meta\":\"");
        let meta_start = s.len() as u32;
        s.push_str(m);
        let meta_end = s.len() as u32;
        s.push('"');
        Some((meta_start, meta_end))
    } else {
        None
    };
    s.push_str(",\"privacy\":\"private\"}");

    (
        s,
        TxInfo::Private {
            changes: (changes_start, changes_end),
            meta: meta_span,
        },
    )
}

/// Build the canonical JSON for a trusting transaction plus its `TxInfo`.
/// Trusting `changes` are plaintext JSON (usually containing quotes), so this
/// always serializes via serde and reports `NeedsParse`.
fn build_trusting_canonical(changes: &str, made_at: u64, meta: Option<&str>) -> (String, TxInfo) {
    let json = serde_json::to_string(&TrustingTxRef {
        changes,
        made_at,
        meta,
        privacy: "trusting",
    })
    .expect("trusting transaction serialization cannot fail");
    (json, TxInfo::NeedsParse)
}

pub enum TransactionMode {
    Private {
        key_id: KeyID,
        key_secret: KeySecret,
    },
    Trusting,
}

#[derive(Clone, Debug)]
pub struct SessionLogInternal {
    public_key: Option<VerifyingKey>,
    hasher: blake3::Hasher,
    transactions_json: Vec<String>,
    /// Payload span side-table, index-aligned with `transactions_json`.
    /// Entry `i` describes where the raw encrypted payload(s) of transaction `i`
    /// live inside `transactions_json[i]` (or `NeedsParse`). May be shorter than
    /// `transactions_json` if a caller pushed raw JSON directly (tests); a
    /// missing entry is treated as `NeedsParse`.
    tx_infos: Vec<TxInfo>,
    last_signature: Option<Signature>,
    nonce_generator: NonceGenerator,
    crypto_cache: CryptoCache,
    /// Staging area for transactions pending validation.
    /// Transactions are added here via add_existing_* methods and committed
    /// to the main state only when commit_transactions() succeeds.
    pending_transactions: Vec<String>,
    /// Span side-table for `pending_transactions`, index-aligned with it.
    pending_tx_infos: Vec<TxInfo>,
    /// In-between signatures at specific transaction indices
    /// Used for chunking large sessions in sync messages
    signature_after: HashMap<u32, String>,
    /// Size tracking for in-between signature decisions
    tx_size_since_last_inbetween_signature: usize,
}

fn validate_tx_size_limit_in_bytes(changes_len: &str) -> Result<(), CoJsonCoreError> {
    if changes_len.len() > MAX_TX_SIZE_BYTES {
        return Err(CoJsonCoreError::TransactionTooLarge(
            changes_len.len(),
            MAX_TX_SIZE_BYTES,
        ));
    }
    Ok(())
}

impl SessionLogInternal {
    /// Create a new session log, optionally with a public key for signature verification.
    pub fn new(co_id: CoID, session_id: SessionID, signer_id: Option<SignerID>) -> Self {
        let hasher = blake3::Hasher::new();

        // If a signer_id is provided, decode and parse it as a VerifyingKey.
        let public_key = match signer_id {
            Some(signer_id) => Some(
                VerifyingKey::try_from(
                    decode_z(&signer_id.0)
                        .expect("Invalid public key")
                        .as_slice(),
                )
                .expect("Invalid public key"),
            ),
            None => None,
        };

        Self {
            public_key,
            hasher,
            transactions_json: Vec::new(),
            tx_infos: Vec::new(),
            last_signature: None,
            nonce_generator: NonceGenerator::new(co_id, session_id),
            crypto_cache: CryptoCache::new(),
            pending_transactions: Vec::new(),
            pending_tx_infos: Vec::new(),
            signature_after: HashMap::new(),
            tx_size_since_last_inbetween_signature: 0,
        }
    }

    /// Get a reference to the list of serialized transaction JSON strings.
    pub fn transactions_json(&self) -> &Vec<String> {
        &self.transactions_json
    }

    /// Get the last signature, if any.
    pub fn last_signature(&self) -> Option<&Signature> {
        self.last_signature.as_ref()
    }

    /// Compute the hash that would result after adding the given transactions.
    /// This is used for signature verification.
    fn expected_hash_after(&self, transactions: &[String]) -> blake3::Hasher {
        let mut hasher = self.hasher.clone();
        for tx in transactions {
            hasher.update(tx.as_bytes());
        }
        hasher
    }

    /// Add a new transaction (private or trusting), encrypting as needed, and sign the new hash.
    /// Returns the new signature and the transaction object.
    pub fn add_new_transaction(
        &mut self,
        changes_json: &str,
        mode: TransactionMode,
        signer_secret: &SignerSecret,
        made_at: u64,
        meta: Option<String>,
    ) -> Result<(Signature, Transaction), CoJsonCoreError> {
        validate_tx_size_limit_in_bytes(changes_json)?;
        // Build the transaction object (for the return value) plus the canonical
        // JSON string and its payload span info (for storage + fast decrypt).
        let (new_tx, tx_json, tx_info) = match mode {
            TransactionMode::Private { key_id, key_secret } => {
                // For private transactions, encrypt the changes and meta fields.
                let tx_index = self.transactions_json.len() as u32;

                // Generate a unique nonce for this transaction.
                let nonce = self.nonce_generator.get_nonce(tx_index);

                // Prepare the secret key bytes for encryption.
                let key: Key<XSalsa20> = self.crypto_cache.get_xsalsa20_key(&key_secret)?;

                // Encrypt the changes JSON.
                let mut ciphertext = changes_json.as_bytes().to_vec();
                let mut cipher = XSalsa20::new(&key, &nonce.into());
                cipher.apply_keystream(&mut ciphertext);
                let encrypted_str = format!("encrypted_U{}", URL_SAFE.encode(&ciphertext));

                // Optionally encrypt the meta field.
                let encrypted_meta = meta.map(|meta| {
                    let mut ciphertext = meta.as_bytes().to_vec();
                    let mut cipher = XSalsa20::new(&key, &nonce.into());
                    cipher.apply_keystream(&mut ciphertext);

                    format!("encrypted_U{}", URL_SAFE.encode(&ciphertext))
                });

                // Build the canonical JSON + spans (byte-identical to serializing
                // the PrivateTransaction below).
                let (tx_json, tx_info) = build_private_canonical(
                    &encrypted_str,
                    &key_id.0,
                    made_at,
                    encrypted_meta.as_deref(),
                );

                // Build the private transaction (returned to the caller).
                let new_tx = Transaction::Private(PrivateTransaction {
                    encrypted_changes: Encrypted {
                        value: encrypted_str,
                        _phantom: std::marker::PhantomData,
                    },
                    key_used: key_id.clone(),
                    made_at: Number::from(made_at),
                    meta: encrypted_meta.map(|value| Encrypted {
                        value,
                        _phantom: std::marker::PhantomData,
                    }),
                    privacy: "private".to_string(),
                });

                (new_tx, tx_json, tx_info)
            }
            TransactionMode::Trusting => {
                // For trusting transactions, just store the changes as plain text.
                let (tx_json, tx_info) =
                    build_trusting_canonical(changes_json, made_at, meta.as_deref());

                let new_tx = Transaction::Trusting(TrustingTransaction {
                    changes: changes_json.to_string(),
                    made_at: Number::from(made_at),
                    meta,
                    privacy: "trusting".to_string(),
                });

                (new_tx, tx_json, tx_info)
            }
        };

        // Update the hash state with the canonical JSON and store it.
        self.hasher.update(tx_json.as_bytes());
        self.transactions_json.push(tx_json);
        self.tx_infos.push(tx_info);

        // Compute the new hash and sign it.
        let new_hash = self.hasher.finalize();
        let new_hash_encoded_stringified = format!(
            "\"hash_z{}\"",
            bs58::encode(new_hash.as_bytes()).into_string()
        );
        let signing_key: SigningKey = self.crypto_cache.get_ed25519_signing_key(signer_secret)?;
        let new_signature: Signature = signing_key
            .sign(new_hash_encoded_stringified.as_bytes())
            .into();

        // Update the last signature.
        self.last_signature = Some(new_signature.clone());

        Ok((new_signature, new_tx))
    }

    /// Stage a private transaction from borrowed inputs (no big owned
    /// allocations beyond the canonical JSON we must store anyway).
    /// The transaction is NOT committed until commit_transactions() succeeds.
    pub fn stage_existing_private(
        &mut self,
        encrypted_changes: &str,
        key_used: &str,
        made_at: u64,
        meta: Option<&str>,
    ) {
        let (tx_json, tx_info) =
            build_private_canonical(encrypted_changes, key_used, made_at, meta);
        self.pending_transactions.push(tx_json);
        self.pending_tx_infos.push(tx_info);
    }

    /// Stage a trusting transaction from borrowed inputs.
    /// The transaction is NOT committed until commit_transactions() succeeds.
    pub fn stage_existing_trusting(&mut self, changes: &str, made_at: u64, meta: Option<&str>) {
        let (tx_json, tx_info) = build_trusting_canonical(changes, made_at, meta);
        self.pending_transactions.push(tx_json);
        self.pending_tx_infos.push(tx_info);
    }

    /// Stage an already-canonical transaction directly.
    ///
    /// `tx_json` MUST be the exact canonical serialization of the transaction
    /// (byte-identical to what `build_private_canonical`/`build_trusting_canonical`
    /// would produce) and `tx_info` its matching payload span table (spans
    /// relative to the start of `tx_json`). Used by the canonical-shape fast
    /// scan import path to avoid re-serializing already-canonical input.
    /// The transaction is NOT committed until commit_transactions() succeeds.
    pub fn stage_canonical(&mut self, tx_json: String, tx_info: TxInfo) {
        self.pending_transactions.push(tx_json);
        self.pending_tx_infos.push(tx_info);
    }

    /// Commit pending transactions to the main state.
    /// If `skip_validate` is false, validates the signature first.
    /// If `skip_validate` is true, commits without validation.
    ///
    /// # Arguments
    /// * `new_signature` - The signature to store (and validate if skip_validate is false)
    /// * `skip_validate` - If true, skip signature validation
    ///
    /// # Returns
    /// * `Ok(())` - Transactions committed successfully
    /// * `Err(CoJsonCoreError::SignatureVerification)` - Signature invalid (only when skip_validate is false)
    ///
    /// # Atomicity
    /// This method guarantees that if it returns an error, the committed state
    /// (hasher, transactions_json, last_signature) remains unchanged.
    pub fn commit_transactions(
        &mut self,
        new_signature: &Signature,
        skip_validate: bool,
    ) -> Result<(), CoJsonCoreError> {
        if !skip_validate {
            // Compute the hash after adding the new transactions.
            let hasher = self.expected_hash_after(&self.pending_transactions);
            let new_hash_encoded_stringified = format!(
                "\"hash_z{}\"",
                bs58::encode(hasher.finalize().as_bytes()).into_string()
            );

            // Verify the signature using the public key, if present.
            if let Some(public_key) = self.public_key {
                match public_key.verify(
                    new_hash_encoded_stringified.as_bytes(),
                    &(new_signature.try_into()?),
                ) {
                    Ok(()) => {}
                    Err(_) => {
                        return Err(CoJsonCoreError::SignatureVerification(
                            new_hash_encoded_stringified.replace("\"", ""),
                        ));
                    }
                }
            } else {
                // No public key available for verification.
                return Err(CoJsonCoreError::SignatureVerification(
                    new_hash_encoded_stringified.replace("\"", ""),
                ));
            }

            // Update the internal hasher state to the new hash.
            self.hasher = hasher;
        }

        // Add new transactions to the session log (keep the span side-table
        // index-aligned with transactions_json).
        self.transactions_json
            .extend(self.pending_transactions.drain(..));
        self.tx_infos.extend(self.pending_tx_infos.drain(..));

        // Update the last signature.
        self.last_signature = Some(new_signature.clone());

        Ok(())
    }

    /// Check if there are pending transactions waiting to be committed.
    pub fn has_pending(&self) -> bool {
        !self.pending_transactions.is_empty()
    }

    /// Decrypt the changes JSON for the transaction at the given index.
    /// Returns the decrypted string, or an error if decryption fails.
    pub fn decrypt_next_transaction_changes_json(
        &self,
        tx_index: u32,
        key_secret: KeySecret,
    ) -> Result<String, CoJsonCoreError> {
        // Get the transaction JSON string at the given index.
        let tx_json = self
            .transactions_json
            .get(tx_index as usize)
            .ok_or(CoJsonCoreError::TransactionNotFound(tx_index))?;

        // Fast path: slice the encrypted payload directly out of the stored
        // canonical JSON, skipping the serde parse entirely.
        if let Some(TxInfo::Private {
            changes: (start, end),
            ..
        }) = self.tx_infos.get(tx_index as usize)
        {
            let encrypted_val = &tx_json[*start as usize..*end as usize];
            return self.decrypt_encrypted_value(tx_index, encrypted_val, &key_secret);
        }

        // Fallback: parse the transaction JSON.
        let tx: Transaction = serde_json::from_str(tx_json)?;

        match tx {
            Transaction::Private(private_tx) => {
                self.decrypt_encrypted_value(tx_index, &private_tx.encrypted_changes.value, &key_secret)
            }
            // For trusting transactions, just return the plain changes.
            Transaction::Trusting(trusting_tx) => Ok(trusting_tx.changes),
        }
    }

    /// Decode + XSalsa20-decrypt an `encrypted_U`-prefixed value using the
    /// nonce for `tx_index`. Shared by the fast (sliced) and fallback (parsed)
    /// decryption paths.
    fn decrypt_encrypted_value(
        &self,
        tx_index: u32,
        encrypted_val: &str,
        key_secret: &KeySecret,
    ) -> Result<String, CoJsonCoreError> {
        let prefix = "encrypted_U";
        if !encrypted_val.starts_with(prefix) {
            return Err(CoJsonCoreError::InvalidEncryptedPrefix);
        }

        // Decode the base64-encoded ciphertext.
        let ciphertext_b64 = &encrypted_val[prefix.len()..];
        let mut ciphertext = URL_SAFE.decode(ciphertext_b64)?;

        // Decrypt using XSalsa20.
        let nonce = self.nonce_generator.get_nonce(tx_index);
        let key = self.crypto_cache.get_xsalsa20_key(key_secret)?;
        let mut cipher = XSalsa20::new(&key, &nonce.into());
        cipher.apply_keystream(&mut ciphertext);

        Ok(String::from_utf8(ciphertext)?)
    }

    /// Decrypt the meta JSON for the transaction at the given index, if present.
    /// Returns the decrypted string, or None if no meta, or an error if decryption fails.
    pub fn decrypt_next_transaction_meta_json(
        &self,
        tx_index: u32,
        key_secret: KeySecret,
    ) -> Result<Option<String>, CoJsonCoreError> {
        // Get the transaction JSON string at the given index.
        let tx_json = self
            .transactions_json
            .get(tx_index as usize)
            .ok_or(CoJsonCoreError::TransactionNotFound(tx_index))?;

        // Fast path: the span side-table tells us exactly whether a (sliceable)
        // meta payload exists, without parsing.
        if let Some(TxInfo::Private { meta, .. }) = self.tx_infos.get(tx_index as usize) {
            return match meta {
                Some((start, end)) => {
                    let encrypted_val = &tx_json[*start as usize..*end as usize];
                    Ok(Some(self.decrypt_encrypted_value(
                        tx_index,
                        encrypted_val,
                        &key_secret,
                    )?))
                }
                // Private + escape-free with no meta span ⇒ definitively no meta.
                None => Ok(None),
            };
        }

        // Fallback: parse the transaction JSON.
        let tx: Transaction = serde_json::from_str(tx_json)?;

        match tx {
            Transaction::Private(private_tx) => {
                // If meta is present, decrypt it.
                if let Some(encrypted_meta) = private_tx.meta {
                    Ok(Some(self.decrypt_encrypted_value(
                        tx_index,
                        &encrypted_meta.value,
                        &key_secret,
                    )?))
                } else {
                    Ok(None)
                }
            }
            // For trusting transactions, just return the plain meta field.
            Transaction::Trusting(trusting_tx) => Ok(trusting_tx.meta),
        }
    }

    // === NEW methods for SessionMapImpl support ===

    /// Get transaction count
    pub fn transaction_count(&self) -> usize {
        self.transactions_json.len()
    }

    /// Get transaction at index (as JSON string)
    pub fn get_transaction(&self, tx_index: usize) -> Option<&str> {
        self.transactions_json.get(tx_index).map(|s| s.as_str())
    }

    /// Get signature after specific transaction index
    pub fn get_signature_after(&self, tx_index: u32) -> Option<&str> {
        self.signature_after.get(&tx_index).map(|s| s.as_str())
    }

    /// Get the last signature checkpoint index (max index in signature_after, or -1)
    pub fn get_last_signature_checkpoint(&self) -> i32 {
        self.signature_after
            .keys()
            .max()
            .map(|&idx| idx as i32)
            .unwrap_or(-1)
    }

    /// Record an in-between signature after committing transactions
    /// Called when tx_size_since_last_inbetween_signature exceeds threshold
    pub fn record_inbetween_signature(&mut self, tx_index: u32, signature: String) {
        self.signature_after.insert(tx_index, signature);
        self.tx_size_since_last_inbetween_signature = 0;
    }

    /// Update size tracking after adding transactions
    pub fn add_to_size_tracking(&mut self, size: usize) {
        self.tx_size_since_last_inbetween_signature += size;
    }

    /// Get the cumulative transaction size since the last in-between signature
    /// Used by SessionMapImpl to check against configurable threshold
    pub fn cumulative_tx_size(&self) -> usize {
        self.tx_size_since_last_inbetween_signature
    }

    /// Get the signature_after map (for iteration in newContentSince)
    pub fn signature_after_map(&self) -> &HashMap<u32, String> {
        &self.signature_after
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use rand_core::OsRng;
    use std::{collections::HashMap, fs};

    #[test]
    fn it_works() {
        let mut csprng = OsRng;
        let signing_key = SigningKey::generate(&mut csprng);
        let verifying_key = signing_key.verifying_key();

        let session = SessionLogInternal::new(
            CoID("co_test1".to_string()),
            SessionID("session_test1".to_string()),
            Some(verifying_key.into()),
        );

        assert!(session.last_signature.is_none());
    }

    #[test]
    fn test_commit_transactions_with_valid_signature() {
        let mut csprng = OsRng;
        let signing_key = SigningKey::generate(&mut csprng);
        let public_key = signing_key.verifying_key();

        let mut session = SessionLogInternal::new(
            CoID("co_test".to_string()),
            SessionID("session_test".to_string()),
            Some(public_key.into()),
        );

        // Stage a trusting transaction
        session
            .stage_existing_trusting(r#"{"test": "data"}"#, 1234567890, None);

        assert!(session.has_pending());
        assert_eq!(session.transactions_json.len(), 0);

        // Compute the expected hash and sign it
        let hasher = session.expected_hash_after(&session.pending_transactions);
        let hash_encoded = format!(
            "\"hash_z{}\"",
            bs58::encode(hasher.finalize().as_bytes()).into_string()
        );
        let signature: Signature = signing_key.sign(hash_encoded.as_bytes()).into();

        // Commit with validation
        let result = session.commit_transactions(&signature, false);
        assert!(result.is_ok());

        // Verify state was updated
        assert!(!session.has_pending());
        assert_eq!(session.transactions_json.len(), 1);
        assert_eq!(session.last_signature, Some(signature));
    }

    #[test]
    fn test_commit_transactions_with_invalid_signature() {
        let mut csprng = OsRng;
        let signing_key = SigningKey::generate(&mut csprng);
        let public_key = signing_key.verifying_key();

        let mut session = SessionLogInternal::new(
            CoID("co_test".to_string()),
            SessionID("session_test".to_string()),
            Some(public_key.into()),
        );

        // Stage a trusting transaction
        session
            .stage_existing_trusting(r#"{"test": "data"}"#, 1234567890, None);

        // Create a wrong signature
        let wrong_signing_key = SigningKey::generate(&mut csprng);
        let wrong_signature: Signature = wrong_signing_key.sign(b"wrong data").into();

        // Commit with validation should fail
        let result = session.commit_transactions(&wrong_signature, false);
        assert!(matches!(
            result,
            Err(CoJsonCoreError::SignatureVerification(_))
        ));

        // Verify committed state unchanged (pending still there)
        assert!(session.has_pending());
        assert_eq!(session.transactions_json.len(), 0);
        assert!(session.last_signature.is_none());
    }

    #[test]
    fn test_commit_transactions_skip_validate() {
        let mut csprng = OsRng;
        let signing_key = SigningKey::generate(&mut csprng);
        let public_key = signing_key.verifying_key();

        let mut session = SessionLogInternal::new(
            CoID("co_test".to_string()),
            SessionID("session_test".to_string()),
            Some(public_key.into()),
        );

        // Stage a trusting transaction
        session
            .stage_existing_trusting(r#"{"test": "data"}"#, 1234567890, None);

        // Use a completely wrong signature but skip validation
        let wrong_signature: Signature = signing_key.sign(b"completely wrong data").into();

        // Commit with skip_validate=true should succeed
        let result = session.commit_transactions(&wrong_signature, true);
        assert!(result.is_ok());

        // Verify state was updated
        assert!(!session.has_pending());
        assert_eq!(session.transactions_json.len(), 1);
        assert_eq!(session.last_signature, Some(wrong_signature));
    }

    #[test]
    fn test_commit_transactions_without_public_key() {
        let mut session = SessionLogInternal::new(
            CoID("co_test".to_string()),
            SessionID("session_test".to_string()),
            None, // No public key
        );

        // Stage a trusting transaction
        session
            .stage_existing_trusting(r#"{"test": "data"}"#, 1234567890, None);

        let mut csprng = OsRng;
        let signing_key = SigningKey::generate(&mut csprng);
        let signature: Signature = signing_key.sign(b"some data").into();

        // Commit with validation should fail (no public key)
        let result = session.commit_transactions(&signature, false);
        assert!(matches!(
            result,
            Err(CoJsonCoreError::SignatureVerification(_))
        ));
    }

    #[test]
    fn test_commit_transactions_multiple_pending() {
        let mut csprng = OsRng;
        let signing_key = SigningKey::generate(&mut csprng);
        let public_key = signing_key.verifying_key();

        let mut session = SessionLogInternal::new(
            CoID("co_test".to_string()),
            SessionID("session_test".to_string()),
            Some(public_key.into()),
        );

        // Stage multiple transactions
        session
            .stage_existing_trusting(r#"{"test": "data1"}"#, 1234567890, None);
        session
            .stage_existing_trusting(r#"{"test": "data2"}"#, 1234567891, None);

        assert_eq!(session.pending_transactions.len(), 2);

        // Compute the expected hash and sign it
        let hasher = session.expected_hash_after(&session.pending_transactions);
        let hash_encoded = format!(
            "\"hash_z{}\"",
            bs58::encode(hasher.finalize().as_bytes()).into_string()
        );
        let signature: Signature = signing_key.sign(hash_encoded.as_bytes()).into();

        // Commit with validation
        let result = session.commit_transactions(&signature, false);
        assert!(result.is_ok());

        // Verify all transactions committed
        assert!(!session.has_pending());
        assert_eq!(session.transactions_json.len(), 2);
    }

    #[test]
    fn test_stage_existing_private() {
        let mut session = SessionLogInternal::new(
            CoID("co_test".to_string()),
            SessionID("session_test".to_string()),
            None,
        );

        // Stage a private transaction
        session.stage_existing_private("encrypted_Utest_data", "test_key_id", 1234567890, None);

        assert!(session.has_pending());
        assert_eq!(session.pending_transactions.len(), 1);

        // Verify the pending transaction contains correct data
        let pending_tx: Transaction =
            serde_json::from_str(&session.pending_transactions[0]).unwrap();
        match pending_tx {
            Transaction::Private(tx) => {
                assert_eq!(tx.encrypted_changes.value, "encrypted_Utest_data");
                assert_eq!(tx.key_used.0, "test_key_id");
                assert_eq!(tx.made_at, Number::from(1234567890));
                assert_eq!(tx.privacy, "private");
            }
            _ => panic!("Expected PrivateTransaction"),
        }
    }

    #[test]
    fn test_stage_existing_trusting() {
        let mut session = SessionLogInternal::new(
            CoID("co_test".to_string()),
            SessionID("session_test".to_string()),
            None,
        );

        // Stage a trusting transaction with meta
        session.stage_existing_trusting(
            r#"{"test": "data"}"#,
            1234567890,
            Some(r#"{"meta": "test"}"#),
        );

        assert!(session.has_pending());
        assert_eq!(session.pending_transactions.len(), 1);

        // Verify the pending transaction contains correct data
        let pending_tx: Transaction =
            serde_json::from_str(&session.pending_transactions[0]).unwrap();
        match pending_tx {
            Transaction::Trusting(tx) => {
                assert_eq!(tx.changes, r#"{"test": "data"}"#);
                assert_eq!(tx.made_at, Number::from(1234567890));
                assert_eq!(tx.meta, Some(r#"{"meta": "test"}"#.to_string()));
                assert_eq!(tx.privacy, "trusting");
            }
            _ => panic!("Expected TrustingTransaction"),
        }
    }

    #[test]
    fn test_commit_empty_pending() {
        let mut csprng = OsRng;
        let signing_key = SigningKey::generate(&mut csprng);
        let public_key = signing_key.verifying_key();

        let mut session = SessionLogInternal::new(
            CoID("co_test".to_string()),
            SessionID("session_test".to_string()),
            Some(public_key.into()),
        );

        // Compute hash with no pending transactions
        let hasher = session.expected_hash_after(&session.pending_transactions);
        let hash_encoded = format!(
            "\"hash_z{}\"",
            bs58::encode(hasher.finalize().as_bytes()).into_string()
        );
        let signature: Signature = signing_key.sign(hash_encoded.as_bytes()).into();

        // Commit empty pending should succeed
        let result = session.commit_transactions(&signature, false);
        assert!(result.is_ok());
        assert_eq!(session.transactions_json.len(), 0);
        assert_eq!(session.last_signature, Some(signature));
    }

    #[test]
    fn test_add_new_transaction() {
        // Load the example data to get all the pieces we need
        let data = fs::read_to_string("data/singleTxSession.json")
            .expect("Unable to read singleTxSession.json");
        let root: serde_json::Value = serde_json::from_str(&data).unwrap();
        let session_data =
            &root["exampleBase"]["co_zkNajJ1BhLzR962jpzvXxx917ZB_session_zXzrQLTtp8rR"];
        let tx_from_example = &session_data["transactions"][0];
        let known_key = &root["knownKeys"][0];

        // Since we don't have the original private key, we generate a new one for this test.
        let mut csprng = OsRng;
        let signing_key = SigningKey::generate(&mut csprng);
        let public_key = signing_key.verifying_key();

        // Initialize an empty session
        let mut session = SessionLogInternal::new(
            CoID(root["coID"].as_str().unwrap().to_string()),
            SessionID("co_zkNajJ1BhLzR962jpzvXxx917ZB_session_zXzrQLTtp8rR".to_string()),
            Some(public_key.into()),
        );

        // The plaintext changes we want to add
        let changes_json =
            r#"[{"after":"start","op":"app","value":"co_zMphsnYN6GU8nn2HDY5suvyGufY"}]"#;

        // Extract all the necessary components from the example data
        let key_secret = KeySecret(known_key["secret"].as_str().unwrap().to_string());
        let key_id = KeyID(known_key["id"].as_str().unwrap().to_string());
        let made_at = tx_from_example["madeAt"].as_u64().unwrap();

        // Call the function we are testing
        let (new_signature, _new_tx) = session
            .add_new_transaction(
                &changes_json,
                TransactionMode::Private { key_id, key_secret },
                &signing_key.into(),
                made_at,
                None,
            )
            .unwrap();

        // 1. Check that the transaction we created matches the one in the file
        let created_tx_json = &session.transactions_json[0];
        let expected_tx_json = serde_json::to_string(tx_from_example).unwrap();
        assert_eq!(created_tx_json, &expected_tx_json);

        // 2. Check that the final hash of the session matches the one in the file
        let final_hash = session.hasher.finalize();
        let final_hash_encoded = format!(
            "hash_z{}",
            bs58::encode(final_hash.as_bytes()).into_string()
        );
        assert_eq!(
            final_hash_encoded,
            session_data["lastHash"].as_str().unwrap()
        );

        let final_hash_encoded_stringified = format!("\"{}\"", final_hash_encoded);

        // 3. Check that the signature is valid for our generated key
        assert!(session
            .public_key
            .expect("Public key should be present")
            .verify(
                final_hash_encoded_stringified.as_bytes(),
                &(&new_signature).try_into().unwrap()
            )
            .is_ok());
        assert_eq!(session.last_signature, Some(new_signature.clone()));

        // Verify we can load the same transaction using direct calls
        let mut session2 = SessionLogInternal::new(
            CoID(root["coID"].as_str().unwrap().to_string()),
            SessionID("co_zkNajJ1BhLzR962jpzvXxx917ZB_session_zXzrQLTtp8rR".to_string()),
            Some(public_key.into()),
        );

        // Parse the created transaction to get its fields
        let created_tx: Transaction = serde_json::from_str(created_tx_json).unwrap();
        match created_tx {
            Transaction::Private(tx) => {
                session2
                    .stage_existing_private(
                        &tx.encrypted_changes.value,
                        &tx.key_used.0,
                        tx.made_at.as_u64().unwrap(),
                        tx.meta.as_ref().map(|m| m.value.as_str()),
                        );
            }
            _ => panic!("Expected PrivateTransaction"),
        }

        session2.commit_transactions(&new_signature, true).unwrap();
        assert_eq!(session2.transactions_json, session.transactions_json);
    }

    #[test]
    fn test_decrypt_from_example_json() {
        #[derive(Deserialize, Debug)]
        struct KnownKey {
            secret: String,
        }

        #[derive(Deserialize, Debug)]
        #[serde(rename_all = "camelCase")]
        struct TestSession {
            last_signature: String,
            transactions: Vec<Transaction>,
        }

        #[derive(Deserialize, Debug)]
        #[serde(rename_all = "camelCase")]
        struct Root {
            example_base: HashMap<String, TestSession>,
            #[serde(rename = "signerID")]
            signer_id: SignerID,
            known_keys: Vec<KnownKey>,
            #[serde(rename = "coID")]
            co_id: CoID,
        }

        let data = fs::read_to_string("data/singleTxSession.json")
            .expect("Unable to read singleTxSession.json");
        let root: Root = serde_json::from_str(&data).unwrap();

        let (session_id_str, example) = root.example_base.into_iter().next().unwrap();
        let session_id = SessionID(session_id_str.clone());

        let public_key =
            VerifyingKey::from_bytes(&decode_z(&root.signer_id.0).unwrap().try_into().unwrap())
                .unwrap();

        let mut session = SessionLogInternal::new(root.co_id, session_id, Some(public_key.into()));

        let new_signature = Signature(example.last_signature);

        // Use direct calls to add transactions
        for tx in example.transactions {
            match tx {
                Transaction::Private(ptx) => {
                    session
                        .stage_existing_private(
                            &ptx.encrypted_changes.value,
                            &ptx.key_used.0,
                            ptx.made_at.as_u64().unwrap(),
                            ptx.meta.as_ref().map(|m| m.value.as_str()),
                            );
                }
                Transaction::Trusting(ttx) => {
                    session
                        .stage_existing_trusting(&ttx.changes, ttx.made_at.as_u64().unwrap(), ttx.meta.as_deref());
                }
            }
        }
        session.commit_transactions(&new_signature, true).unwrap();

        let key_secret = KeySecret(root.known_keys[0].secret.clone());

        let decrypted = session
            .decrypt_next_transaction_changes_json(0, key_secret)
            .unwrap();

        assert_eq!(
            decrypted,
            r#"[{"after":"start","op":"app","value":"co_zMphsnYN6GU8nn2HDY5suvyGufY"}]"#
        );
    }

    #[test]
    fn test_decrypt_meta_from_example_json() {
        #[derive(Deserialize, Debug)]
        struct KnownKey {
            secret: String,
        }

        #[derive(Deserialize, Debug)]
        #[serde(rename_all = "camelCase")]
        struct TestSession {
            last_signature: String,
            transactions: Vec<Transaction>,
        }

        #[derive(Deserialize, Debug)]
        #[serde(rename_all = "camelCase")]
        struct Root {
            example_base: HashMap<String, TestSession>,
            #[serde(rename = "signerID")]
            signer_id: SignerID,
            known_keys: Vec<KnownKey>,
            #[serde(rename = "coID")]
            co_id: CoID,
        }

        let data = fs::read_to_string("data/singleTxSessionMeta.json")
            .expect("Unable to read singleTxSessionMeta.json");
        let root: Root = serde_json::from_str(&data).unwrap();

        let (session_id_str, example) = root.example_base.into_iter().next().unwrap();
        let session_id = SessionID(session_id_str.clone());

        let public_key =
            VerifyingKey::from_bytes(&decode_z(&root.signer_id.0).unwrap().try_into().unwrap())
                .unwrap();

        let mut session = SessionLogInternal::new(root.co_id, session_id, Some(public_key.into()));

        let new_signature = Signature(example.last_signature);

        // Use direct calls to add transactions
        for tx in example.transactions {
            match tx {
                Transaction::Private(ptx) => {
                    session
                        .stage_existing_private(
                            &ptx.encrypted_changes.value,
                            &ptx.key_used.0,
                            ptx.made_at.as_u64().unwrap(),
                            ptx.meta.as_ref().map(|m| m.value.as_str()),
                            );
                }
                Transaction::Trusting(ttx) => {
                    session
                        .stage_existing_trusting(&ttx.changes, ttx.made_at.as_u64().unwrap(), ttx.meta.as_deref());
                }
            }
        }
        session.commit_transactions(&new_signature, true).unwrap();

        let key_secret = KeySecret(root.known_keys[0].secret.clone());

        let decrypted = session
            .decrypt_next_transaction_meta_json(0, key_secret)
            .unwrap();

        assert_eq!(decrypted, Some(r#"{"meta":{"test":"test"}}"#.to_string()));
    }

    #[test]
    fn test_add_new_transaction_meta() {
        const META_JSON: &str = r#"{"meta":{"test":"test"}}"#;
        const CHANGES_JSON: &str = r#"[]"#;
        const SESSION_ID: &str = "co_ziwYjGfPdBjvc1bnCufaVdWLozm_session_zj5NjtJL6s5p";

        // Load the example data to get all the pieces we need
        let data = fs::read_to_string("data/singleTxSessionMeta.json")
            .expect("Unable to read singleTxSession.json");
        let root: serde_json::Value = serde_json::from_str(&data).unwrap();
        let session_data = &root["exampleBase"][SESSION_ID];
        let tx_from_example = &session_data["transactions"][0];
        let known_key = &root["knownKeys"][0];

        // Since we don't have the original private key, we generate a new one for this test.
        let mut csprng = OsRng;
        let signing_key = SigningKey::generate(&mut csprng);
        let public_key = signing_key.verifying_key();

        // Initialize an empty session
        let mut session = SessionLogInternal::new(
            CoID(root["coID"].as_str().unwrap().to_string()),
            SessionID(SESSION_ID.to_string()),
            Some(public_key.into()),
        );

        // Extract all the necessary components from the example data
        let key_secret = KeySecret(known_key["secret"].as_str().unwrap().to_string());
        let key_id = KeyID(known_key["id"].as_str().unwrap().to_string());
        let made_at = tx_from_example["madeAt"].as_u64().unwrap();

        // Call the function we are testing
        let (new_signature, _new_tx) = session
            .add_new_transaction(
                CHANGES_JSON,
                TransactionMode::Private { key_id, key_secret },
                &signing_key.into(),
                made_at,
                Some(META_JSON.to_string()),
            )
            .unwrap();

        // 1. Check that the transaction we created matches the one in the file
        let created_tx_json = &session.transactions_json[0];
        let expected_tx_json = serde_json::to_string(tx_from_example).unwrap();
        assert_eq!(created_tx_json, &expected_tx_json);

        // 2. Check that the final hash of the session matches the one in the file
        let final_hash = session.hasher.finalize();
        let final_hash_encoded = format!(
            "hash_z{}",
            bs58::encode(final_hash.as_bytes()).into_string()
        );

        let final_hash_encoded_stringified = format!("\"{}\"", final_hash_encoded);

        // 3. Check that the signature is valid for our generated key
        assert!(session
            .public_key
            .expect("Public key should be present")
            .verify(
                final_hash_encoded_stringified.as_bytes(),
                &(&new_signature).try_into().unwrap()
            )
            .is_ok());
        assert_eq!(session.last_signature, Some(new_signature.clone()));

        // Verify we can load the same transaction using direct calls
        let mut session2 = SessionLogInternal::new(
            CoID(root["coID"].as_str().unwrap().to_string()),
            SessionID("co_ziwYjGfPdBjvc1bnCufaVdWLozm_session_zj5NjtJL6s5p".to_string()),
            Some(public_key.into()),
        );

        // Parse the created transaction to get its fields
        let created_tx: Transaction = serde_json::from_str(created_tx_json).unwrap();
        match created_tx {
            Transaction::Private(tx) => {
                session2
                    .stage_existing_private(
                        &tx.encrypted_changes.value,
                        &tx.key_used.0,
                        tx.made_at.as_u64().unwrap(),
                        tx.meta.as_ref().map(|m| m.value.as_str()),
                        );
            }
            _ => panic!("Expected PrivateTransaction"),
        }

        session2.commit_transactions(&new_signature, true).unwrap();
        assert_eq!(session2.transactions_json, session.transactions_json);
    }

    #[test]
    fn test_transaction_not_found_error() {
        let session = SessionLogInternal::new(
            CoID("co_test".to_string()),
            SessionID("session_test".to_string()),
            None,
        );

        let key_secret = KeySecret("test_key".to_string());

        // Try to decrypt from non-existent transaction index
        let result = session.decrypt_next_transaction_changes_json(999, key_secret.clone());
        assert!(matches!(
            result,
            Err(CoJsonCoreError::TransactionNotFound(999))
        ));

        let result = session.decrypt_next_transaction_meta_json(999, key_secret);
        assert!(matches!(
            result,
            Err(CoJsonCoreError::TransactionNotFound(999))
        ));
    }

    #[test]
    fn test_invalid_encrypted_prefix_error() {
        let mut session = SessionLogInternal::new(
            CoID("co_test".to_string()),
            SessionID("session_test".to_string()),
            None,
        );

        // Create a transaction with invalid encrypted prefix
        let invalid_tx = Transaction::Private(PrivateTransaction {
            encrypted_changes: Encrypted {
                value: "invalid_prefix_some_data".to_string(),
                _phantom: std::marker::PhantomData,
            },
            key_used: KeyID("test_key".to_string()),
            made_at: Number::from(1234567890),
            meta: None,
            privacy: "private".to_string(),
        });

        let tx_json = serde_json::to_string(&invalid_tx).unwrap();
        session.transactions_json.push(tx_json);

        let key_secret = KeySecret("test_key".to_string());

        let result = session.decrypt_next_transaction_changes_json(0, key_secret.clone());
        assert!(matches!(
            result,
            Err(CoJsonCoreError::InvalidEncryptedPrefix)
        ));
    }

    #[test]
    fn test_trusting_transaction_mode() {
        let mut csprng = OsRng;
        let signing_key = SigningKey::generate(&mut csprng);
        let public_key = signing_key.verifying_key();

        let mut session = SessionLogInternal::new(
            CoID("co_test".to_string()),
            SessionID("session_test".to_string()),
            Some(public_key.into()),
        );

        let changes_json = r#"{"test": "data", "value": 42}"#;
        let meta_json = Some(r#"{"meta": "test"}"#.to_string());
        let made_at = 1234567890;

        let (signature, transaction) = session
            .add_new_transaction(
                &changes_json,
                TransactionMode::Trusting,
                &signing_key.into(),
                made_at,
                meta_json.clone(),
            )
            .unwrap();

        // Verify the transaction is a TrustingTransaction
        match transaction {
            Transaction::Trusting(tx) => {
                assert_eq!(tx.changes, changes_json);
                assert_eq!(tx.meta, meta_json);
                assert_eq!(tx.made_at, Number::from(made_at));
                assert_eq!(tx.privacy, "trusting");
            }
            _ => panic!("Expected TrustingTransaction"),
        }

        // Verify we can decrypt the changes (should return plain text for trusting transactions)
        let decrypted = session
            .decrypt_next_transaction_changes_json(0, KeySecret("dummy".to_string()))
            .unwrap();
        assert_eq!(decrypted, changes_json);

        // Verify we can decrypt the meta (should return plain text for trusting transactions)
        let decrypted_meta = session
            .decrypt_next_transaction_meta_json(0, KeySecret("dummy".to_string()))
            .unwrap();
        assert_eq!(decrypted_meta, meta_json);

        // Verify signature is valid
        let final_hash = session.hasher.finalize();
        let final_hash_encoded_stringified = format!(
            "\"hash_z{}\"",
            bs58::encode(final_hash.as_bytes()).into_string()
        );
        assert!(session
            .public_key
            .expect("Public key should be present")
            .verify(
                final_hash_encoded_stringified.as_bytes(),
                &(&signature).try_into().unwrap()
            )
            .is_ok());
    }

    #[test]
    fn test_getters() {
        let session = SessionLogInternal::new(
            CoID("co_test".to_string()),
            SessionID("session_test".to_string()),
            None,
        );

        // Test transactions_json getter
        let transactions = session.transactions_json();
        assert!(transactions.is_empty());

        // Test last_signature getter
        let last_sig = session.last_signature();
        assert!(last_sig.is_none());
    }

    #[test]
    fn test_session_creation_without_signer_id() {
        let session = SessionLogInternal::new(
            CoID("co_test".to_string()),
            SessionID("session_test".to_string()),
            None,
        );

        assert!(session.public_key.is_none());
        assert!(session.last_signature.is_none());
        assert!(session.transactions_json.is_empty());
    }

    #[test]
    fn test_session_creation_with_signer_id() {
        let mut csprng = OsRng;
        let signing_key = SigningKey::generate(&mut csprng);
        let public_key = signing_key.verifying_key();

        let session = SessionLogInternal::new(
            CoID("co_test".to_string()),
            SessionID("session_test".to_string()),
            Some(public_key.into()),
        );

        assert!(session.public_key.is_some());
        assert!(session.last_signature.is_none());
        assert!(session.transactions_json.is_empty());
    }

    #[test]
    fn test_multiple_transactions() {
        let mut csprng = OsRng;
        let signing_key = SigningKey::generate(&mut csprng);
        let public_key = signing_key.verifying_key();
        let signer_secret = signing_key.into();

        let mut session = SessionLogInternal::new(
            CoID("co_test".to_string()),
            SessionID("session_test".to_string()),
            Some(public_key.into()),
        );

        // Add multiple transactions
        for i in 0..3 {
            let changes_json = format!(r#"{{"test": "data_{}"}}"#, i);
            let (_, _) = session
                .add_new_transaction(
                    &changes_json,
                    TransactionMode::Trusting,
                    &signer_secret,
                    1234567890 + i,
                    None,
                )
                .unwrap();
        }

        assert_eq!(session.transactions_json.len(), 3);

        // Verify we can decrypt each transaction
        for i in 0..3 {
            let expected_changes = format!(r#"{{"test": "data_{}"}}"#, i);
            let decrypted = session
                .decrypt_next_transaction_changes_json(i, KeySecret("dummy".to_string()))
                .unwrap();
            assert_eq!(decrypted, expected_changes);
        }
    }

    #[test]
    fn test_private_transaction_without_meta() {
        let mut csprng = OsRng;
        let signing_key = SigningKey::generate(&mut csprng);
        let public_key = signing_key.verifying_key();

        let mut session = SessionLogInternal::new(
            CoID("co_test".to_string()),
            SessionID("session_test".to_string()),
            Some(public_key.into()),
        );

        // Create a properly formatted KeySecret with "_z" prefix
        let key_bytes = [1u8; 32]; // 32 bytes of test data
        let key_secret = KeySecret(format!("key_z{}", bs58::encode(key_bytes).into_string()));
        let key_id = KeyID("test_key_id".to_string());
        let changes_json = r#"{"test": "data"}"#;

        let (_, transaction) = session
            .add_new_transaction(
                &changes_json,
                TransactionMode::Private {
                    key_id: key_id.clone(),
                    key_secret: key_secret.clone(),
                },
                &signing_key.into(),
                1234567890,
                None, // No meta
            )
            .unwrap();

        // Verify it's a private transaction
        match transaction {
            Transaction::Private(tx) => {
                assert_eq!(tx.key_used, key_id);
                assert_eq!(tx.made_at, Number::from(1234567890));
                assert_eq!(tx.privacy, "private");
                assert!(tx.meta.is_none());
            }
            _ => panic!("Expected PrivateTransaction"),
        }

        // Verify we can decrypt the changes
        let decrypted = session
            .decrypt_next_transaction_changes_json(0, key_secret.clone())
            .unwrap();
        assert_eq!(decrypted, changes_json);

        // Verify meta decryption returns None
        let decrypted_meta = session
            .decrypt_next_transaction_meta_json(0, key_secret)
            .unwrap();
        assert!(decrypted_meta.is_none());
    }

    #[test]
    fn test_malformed_json_error() {
        let mut session = SessionLogInternal::new(
            CoID("co_test".to_string()),
            SessionID("session_test".to_string()),
            None,
        );

        // Add malformed JSON to transactions
        session.transactions_json.push("invalid json".to_string());

        let key_secret = KeySecret("test_key".to_string());

        let result = session.decrypt_next_transaction_changes_json(0, key_secret.clone());
        assert!(matches!(result, Err(CoJsonCoreError::Json(_))));

        let result = session.decrypt_next_transaction_meta_json(0, key_secret);
        assert!(matches!(result, Err(CoJsonCoreError::Json(_))));
    }

    #[test]
    fn test_base64_decode_error() {
        let mut session = SessionLogInternal::new(
            CoID("co_test".to_string()),
            SessionID("session_test".to_string()),
            None,
        );

        // Create a transaction with invalid base64
        let invalid_tx = Transaction::Private(PrivateTransaction {
            encrypted_changes: Encrypted {
                value: "encrypted_Uinvalid_base64!@#$%".to_string(),
                _phantom: std::marker::PhantomData,
            },
            key_used: KeyID("test_key".to_string()),
            made_at: Number::from(1234567890),
            meta: None,
            privacy: "private".to_string(),
        });

        let tx_json = serde_json::to_string(&invalid_tx).unwrap();
        session.transactions_json.push(tx_json);

        let key_secret = KeySecret("test_key".to_string());

        let result = session.decrypt_next_transaction_changes_json(0, key_secret.clone());
        assert!(matches!(result, Err(CoJsonCoreError::Base64Decode(_))));
    }

    #[test]
    fn test_utf8_decode_error() {
        let _session = SessionLogInternal::new(
            CoID("co_test".to_string()),
            SessionID("session_test".to_string()),
            None,
        );

        // Create a transaction with invalid UTF-8 data (this is tricky to create directly)
        // We'll use a different approach - create valid encrypted data but with wrong key
        let key_bytes = [1u8; 32]; // 32 bytes of test data
        let key_secret = KeySecret(format!("key_z{}", bs58::encode(key_bytes).into_string()));
        let key_id = KeyID("test_key_id".to_string());

        let mut csprng = OsRng;
        let signing_key = SigningKey::generate(&mut csprng);
        let public_key = signing_key.verifying_key();

        let mut session_with_tx = SessionLogInternal::new(
            CoID("co_test".to_string()),
            SessionID("session_test".to_string()),
            Some(public_key.into()),
        );

        // Add a valid transaction
        let (_, _) = session_with_tx
            .add_new_transaction(
                &r#"{"test": "data"}"#,
                TransactionMode::Private {
                    key_id: key_id.clone(),
                    key_secret: key_secret.clone(),
                },
                &signing_key.into(),
                1234567890,
                None,
            )
            .unwrap();

        // Now try to decrypt with a different key (this will result in garbage UTF-8)
        let wrong_key_bytes = [2u8; 32]; // Different 32 bytes
        let wrong_key = KeySecret(format!(
            "key_z{}",
            bs58::encode(wrong_key_bytes).into_string()
        ));
        let result = session_with_tx.decrypt_next_transaction_changes_json(0, wrong_key);

        // This should fail with UTF-8 error since decryption with wrong key produces garbage
        assert!(matches!(result, Err(CoJsonCoreError::Utf8(_))));
    }

    #[test]
    fn test_expected_hash_after_function() {
        let session = SessionLogInternal::new(
            CoID("co_test".to_string()),
            SessionID("session_test".to_string()),
            None,
        );

        // This tests the expected_hash_after function indirectly through commit_transactions
        let mut test_session = session.clone();

        // Add multiple transactions using direct calls
        test_session
            .stage_existing_trusting(r#"{"test":"data1"}"#, 1234567890, None);
        test_session
            .stage_existing_trusting(r#"{"test":"data2"}"#, 1234567890, None);

        let signature: Signature = SigningKey::generate(&mut OsRng).sign(b"test").into();

        // This should work with skip_validate = true
        let result = test_session.commit_transactions(&signature, true);
        assert!(result.is_ok());
        assert_eq!(test_session.transactions_json.len(), 2);
    }

    #[test]
    fn test_transaction_id_serialization() {
        let session_id = SessionID("test_session".to_string());
        let tx_id = TransactionID {
            session_id: session_id.clone(),
            tx_index: 42,
        };

        // Test serialization
        let serialized = serde_json::to_string(&tx_id).unwrap();
        let expected = r#"{"sessionID":"test_session","txIndex":42}"#;
        assert_eq!(serialized, expected);

        // Test deserialization
        let deserialized: TransactionID = serde_json::from_str(&serialized).unwrap();
        assert_eq!(deserialized, tx_id);
    }

    #[test]
    fn test_encrypted_struct_serialization() {
        let encrypted = Encrypted::<JsonValue> {
            value: "test_encrypted_data".to_string(),
            _phantom: std::marker::PhantomData,
        };

        // Test serialization
        let serialized = serde_json::to_string(&encrypted).unwrap();
        assert_eq!(serialized, "\"test_encrypted_data\"");

        // Test deserialization
        let deserialized: Encrypted<JsonValue> = serde_json::from_str(&serialized).unwrap();
        assert_eq!(deserialized.value, encrypted.value);
    }

    #[test]
    fn test_transaction_enum_serialization() {
        // Test Private transaction serialization
        let private_tx = Transaction::Private(PrivateTransaction {
            encrypted_changes: Encrypted {
                value: "encrypted_Utest_data".to_string(),
                _phantom: std::marker::PhantomData,
            },
            key_used: KeyID("test_key".to_string()),
            made_at: Number::from(1234567890),
            meta: None,
            privacy: "private".to_string(),
        });

        let serialized = serde_json::to_string(&private_tx).unwrap();
        assert!(serialized.contains("\"privacy\":\"private\""));
        assert!(serialized.contains("\"keyUsed\":\"test_key\""));

        // Test Trusting transaction serialization
        let trusting_tx = Transaction::Trusting(TrustingTransaction {
            changes: r#"{"test": "data"}"#.to_string(),
            made_at: Number::from(1234567890),
            meta: None,
            privacy: "trusting".to_string(),
        });

        let serialized = serde_json::to_string(&trusting_tx).unwrap();
        assert!(serialized.contains("\"privacy\":\"trusting\""));
        assert!(serialized.contains("\"changes\":\"{\\\"test\\\": \\\"data\\\"}\""));
    }

    // ========================================================================
    // Canonical serialization byte-identity + span tests
    // ========================================================================

    /// Old-types serialization used as the byte-identity oracle.
    fn oracle_private(
        encrypted_changes: &str,
        key_used: &str,
        made_at: u64,
        meta: Option<&str>,
    ) -> String {
        serde_json::to_string(&Transaction::Private(PrivateTransaction {
            encrypted_changes: Encrypted {
                value: encrypted_changes.to_string(),
                _phantom: std::marker::PhantomData,
            },
            key_used: KeyID(key_used.to_string()),
            made_at: Number::from(made_at),
            meta: meta.map(|m| Encrypted {
                value: m.to_string(),
                _phantom: std::marker::PhantomData,
            }),
            privacy: "private".to_string(),
        }))
        .unwrap()
    }

    fn oracle_trusting(changes: &str, made_at: u64, meta: Option<&str>) -> String {
        serde_json::to_string(&Transaction::Trusting(TrustingTransaction {
            changes: changes.to_string(),
            made_at: Number::from(made_at),
            meta: meta.map(|m| m.to_string()),
            privacy: "trusting".to_string(),
        }))
        .unwrap()
    }

    #[test]
    fn test_canonical_private_byte_identity() {
        let cases: &[(&str, &str, u64, Option<&str>)] = &[
            // No meta, base64url payload (escape-free -> fast path)
            (
                "encrypted_UabcDEF-_123",
                "key_z11111111111111111111111111111111",
                1234567890,
                None,
            ),
            // With meta (both escape-free)
            (
                "encrypted_UabcDEF-_123",
                "key_z22222222222222222222222222222222",
                42,
                Some("encrypted_UzzzYYY-_999"),
            ),
            // Non-ASCII in value: serde does NOT escape it, so it stays sliceable
            (
                "encrypted_Ucafé_ünïcode",
                "key_zabc",
                0,
                Some("encrypted_Uméta"),
            ),
            // Escaping required in changes -> must fall back to NeedsParse
            (
                "encrypted_U\"quote\\backslash",
                "key_zabc",
                7,
                None,
            ),
            // Escaping required only in meta -> whole tx falls back
            (
                "encrypted_Uclean",
                "key_zabc",
                7,
                Some("encrypted_U\"escaped\""),
            ),
            // Escaping required in keyUsed -> whole tx falls back
            (
                "encrypted_Uclean",
                "key_\"weird\"",
                7,
                Some("encrypted_Uclean_meta"),
            ),
        ];

        for (ec, ku, made_at, meta) in cases.iter().copied() {
            let (json, info) = build_private_canonical(ec, ku, made_at, meta);
            let expected = oracle_private(ec, ku, made_at, meta);
            assert_eq!(json, expected, "byte mismatch for private tx {:?}", ec);

            let needs_escape =
                json_needs_escape(ec) || json_needs_escape(ku) || meta.map_or(false, json_needs_escape);
            match info {
                TxInfo::Private { changes, meta: mspan } => {
                    assert!(!needs_escape, "expected NeedsParse for escaped input {:?}", ec);
                    // Sliced changes value equals the logical value.
                    assert_eq!(&json[changes.0 as usize..changes.1 as usize], ec);
                    match (mspan, meta) {
                        (Some(span), Some(m)) => {
                            assert_eq!(&json[span.0 as usize..span.1 as usize], m);
                        }
                        (None, None) => {}
                        _ => panic!("meta span presence mismatch for {:?}", ec),
                    }
                }
                TxInfo::NeedsParse => {
                    assert!(needs_escape, "unexpected NeedsParse for clean input {:?}", ec);
                }
            }
        }
    }

    #[test]
    fn test_canonical_trusting_byte_identity() {
        let cases: &[(&str, u64, Option<&str>)] = &[
            (r#"[{"op":"app","value":"x"}]"#, 1234567890, None),
            (r#"[]"#, 0, Some(r#"{"m":"é"}"#)),
        ];
        for (ch, made_at, meta) in cases.iter().copied() {
            let (json, info) = build_trusting_canonical(ch, made_at, meta);
            let expected = oracle_trusting(ch, made_at, meta);
            assert_eq!(json, expected, "byte mismatch for trusting tx {:?}", ch);
            assert!(matches!(info, TxInfo::NeedsParse));
        }
    }

    #[test]
    fn test_escaped_private_payload_falls_back_to_needs_parse_and_still_decrypts() {
        // Build a real encrypted private tx, then decrypt via both the fast path
        // (clean payload) and confirm the fallback path is exercised when the
        // side-table entry is NeedsParse.
        let mut csprng = OsRng;
        let signing_key = SigningKey::generate(&mut csprng);
        let public_key = signing_key.verifying_key();
        let key_bytes = [7u8; 32];
        let key_secret = KeySecret(format!("key_z{}", bs58::encode(key_bytes).into_string()));
        let key_id = KeyID("key_zabc".to_string());

        let mut session = SessionLogInternal::new(
            CoID("co_test".to_string()),
            SessionID("session_test".to_string()),
            Some(public_key.into()),
        );
        let changes = r#"[{"op":"app","value":"hello"}]"#;
        session
            .add_new_transaction(
                changes,
                TransactionMode::Private {
                    key_id,
                    key_secret: key_secret.clone(),
                },
                &signing_key.into(),
                123,
                None,
            )
            .unwrap();

        // Fast path (side table has spans).
        let fast = session
            .decrypt_next_transaction_changes_json(0, key_secret.clone())
            .unwrap();
        assert_eq!(fast, changes);

        // Now corrupt the side table to force the parse fallback and ensure it
        // still decrypts to the same plaintext.
        session.tx_infos[0] = TxInfo::NeedsParse;
        let slow = session
            .decrypt_next_transaction_changes_json(0, key_secret)
            .unwrap();
        assert_eq!(slow, changes);
    }
}
