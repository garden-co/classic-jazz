use crate::crypto::error::CryptoError;
use crate::crypto::x25519::x25519_diffie_hellman;
use crate::crypto::xsalsa20::{decrypt_xsalsa20_poly1305, encrypt_xsalsa20_poly1305};
use crate::hash::blake3::generate_nonce;
use bs58;

/// Internal function to seal a message using X25519 + XSalsa20-Poly1305.
/// - `message`: Raw bytes to seal
/// - `sender_secret`: Base58-encoded sender's private key with "sealerSecret_z" prefix
/// - `recipient_id`: Base58-encoded recipient's public key with "sealer_z" prefix
/// - `nonce_material`: Raw bytes used to generate the nonce
/// Returns sealed bytes or CryptoError if key formats are invalid.
///
/// The sealing process:
/// 1. Decode base58 keys and validate prefixes
/// 2. Generate shared secret using X25519 key exchange
/// 3. Generate nonce from nonce material using BLAKE3
/// 4. Encrypt message using XSalsa20-Poly1305 with the shared secret
pub fn seal(
    message: &[u8],
    sender_secret: &str,
    recipient_id: &str,
    nonce_material: &[u8],
) -> Result<Box<[u8]>, CryptoError> {
    // Decode the base58 sender secret (removing the "sealerSecret_z" prefix)
    let sender_secret =
        sender_secret
            .strip_prefix("sealerSecret_z")
            .ok_or(CryptoError::InvalidPrefix(
                "sealer secret",
                "sealerSecret_z",
            ))?;
    let sender_private_key = bs58::decode(sender_secret)
        .into_vec()
        .map_err(|e| CryptoError::Base58Error(e.to_string()))?;

    // Decode the base58 recipient ID (removing the "sealer_z" prefix)
    let recipient_id = recipient_id
        .strip_prefix("sealer_z")
        .ok_or(CryptoError::InvalidPrefix("sealer ID", "sealer_z"))?;
    let recipient_public_key = bs58::decode(recipient_id)
        .into_vec()
        .map_err(|e| CryptoError::Base58Error(e.to_string()))?;

    let nonce = generate_nonce(nonce_material);

    // Generate shared secret using X25519
    let shared_secret = x25519_diffie_hellman(&sender_private_key, &recipient_public_key)?;

    // Encrypt message using XSalsa20-Poly1305
    encrypt_xsalsa20_poly1305(&shared_secret, &nonce, message)
}

/// Internal function to unseal a message using X25519 + XSalsa20-Poly1305.
/// - `sealed_message`: The sealed bytes to decrypt
/// - `recipient_secret`: Base58-encoded recipient's private key with "sealerSecret_z" prefix
/// - `sender_id`: Base58-encoded sender's public key with "sealer_z" prefix
/// - `nonce_material`: Raw bytes used to generate the nonce (must match sealing)
/// Returns unsealed bytes or CryptoError if key formats are invalid or authentication fails.
///
/// The unsealing process:
/// 1. Decode base58 keys and validate prefixes
/// 2. Generate shared secret using X25519 key exchange
/// 3. Generate nonce from nonce material using BLAKE3
/// 4. Decrypt and authenticate message using XSalsa20-Poly1305 with the shared secret
pub fn unseal(
    sealed_message: &[u8],
    recipient_secret: &str,
    sender_id: &str,
    nonce_material: &[u8],
) -> Result<Box<[u8]>, CryptoError> {
    // Decode the base58 recipient secret (removing the "sealerSecret_z" prefix)
    let recipient_secret =
        recipient_secret
            .strip_prefix("sealerSecret_z")
            .ok_or(CryptoError::InvalidPrefix(
                "sealer secret",
                "sealerSecret_z",
            ))?;
    let recipient_private_key = bs58::decode(recipient_secret)
        .into_vec()
        .map_err(|e| CryptoError::Base58Error(e.to_string()))?;

    // Decode the base58 sender ID (removing the "sealer_z" prefix)
    let sender_id = sender_id
        .strip_prefix("sealer_z")
        .ok_or(CryptoError::InvalidPrefix("sealer ID", "sealer_z"))?;
    let sender_public_key = bs58::decode(sender_id)
        .into_vec()
        .map_err(|e| CryptoError::Base58Error(e.to_string()))?;

    let nonce = generate_nonce(nonce_material);

    // Generate shared secret using X25519
    let shared_secret = x25519_diffie_hellman(&recipient_private_key, &sender_public_key)?;

    // Decrypt message using XSalsa20-Poly1305
    decrypt_xsalsa20_poly1305(&shared_secret, &nonce, sealed_message)
}

/// Seal a message for a group using anonymous box pattern.
/// The sender generates an ephemeral key pair, so no sender authentication is provided.
/// The ephemeral public key is prepended to the ciphertext.
/// - `message`: Raw bytes to seal
/// - `recipient_id`: Base58-encoded recipient's public key with "sealer_z" prefix
/// - `nonce_material`: Raw bytes used to generate the nonce
/// Returns ephemeral_public_key (32 bytes) || ciphertext
pub fn seal_for_group(
    message: &[u8],
    recipient_id: &str,
    nonce_material: &[u8],
) -> Result<Box<[u8]>, CryptoError> {
    use crate::crypto::x25519::{new_x25519_private_key, x25519_public_key};

    // Generate ephemeral key pair
    let ephemeral_private = new_x25519_private_key();
    let ephemeral_public = x25519_public_key(&ephemeral_private)?;

    // Decode the base58 recipient ID (removing the "sealer_z" prefix)
    let recipient_id_stripped = recipient_id
        .strip_prefix("sealer_z")
        .ok_or(CryptoError::InvalidPrefix("sealer ID", "sealer_z"))?;
    let recipient_public_key = bs58::decode(recipient_id_stripped)
        .into_vec()
        .map_err(|e| CryptoError::Base58Error(e.to_string()))?;

    let nonce = generate_nonce(nonce_material);

    // Generate shared secret using X25519 with ephemeral private key
    let shared_secret = x25519_diffie_hellman(&ephemeral_private, &recipient_public_key)?;

    // Encrypt message using XSalsa20-Poly1305
    let ciphertext = encrypt_xsalsa20_poly1305(&shared_secret, &nonce, message)?;

    // Prepend ephemeral public key to ciphertext
    let mut result = Vec::with_capacity(32 + ciphertext.len());
    result.extend_from_slice(&ephemeral_public);
    result.extend_from_slice(&ciphertext);

    Ok(result.into_boxed_slice())
}

/// Unseal a message that was sealed for a group using anonymous box pattern.
/// Extracts the ephemeral public key from the sealed message and decrypts.
/// - `sealed_message`: ephemeral_public_key (32 bytes) || ciphertext
/// - `recipient_secret`: Base58-encoded recipient's private key with "sealerSecret_z" prefix
/// - `nonce_material`: Raw bytes used to generate the nonce (must match sealing)
/// Returns unsealed bytes or CryptoError if decryption fails.
pub fn unseal_for_group(
    sealed_message: &[u8],
    recipient_secret: &str,
    nonce_material: &[u8],
) -> Result<Box<[u8]>, CryptoError> {
    // Check minimum length (32 bytes ephemeral public key + at least some ciphertext)
    if sealed_message.len() < 32 {
        return Err(CryptoError::InvalidKeyLength(32, sealed_message.len()));
    }

    // Extract ephemeral public key and ciphertext
    let ephemeral_public = &sealed_message[..32];
    let ciphertext = &sealed_message[32..];

    // Decode the base58 recipient secret (removing the "sealerSecret_z" prefix)
    let recipient_secret_stripped =
        recipient_secret
            .strip_prefix("sealerSecret_z")
            .ok_or(CryptoError::InvalidPrefix(
                "sealer secret",
                "sealerSecret_z",
            ))?;
    let recipient_private_key = bs58::decode(recipient_secret_stripped)
        .into_vec()
        .map_err(|e| CryptoError::Base58Error(e.to_string()))?;

    let nonce = generate_nonce(nonce_material);

    // Generate shared secret using X25519 with recipient private key and ephemeral public key
    let shared_secret = x25519_diffie_hellman(&recipient_private_key, ephemeral_public)?;

    // Decrypt message using XSalsa20-Poly1305
    decrypt_xsalsa20_poly1305(&shared_secret, &nonce, ciphertext)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::crypto::x25519::{new_x25519_private_key, x25519_public_key};

    #[test]
    fn test_seal_unseal() {
        // Generate real keys
        let sender_private = new_x25519_private_key();
        let sender_public = x25519_public_key(&sender_private).unwrap();

        // Encode keys with proper prefixes
        let sender_secret = format!(
            "sealerSecret_z{}",
            bs58::encode(&sender_private).into_string()
        );
        let recipient_id = format!("sealer_z{}", bs58::encode(&sender_public).into_string());

        // Test data
        let message = b"Secret message";
        let nonce_material = b"test_nonce_material";

        // Test sealing
        let sealed = seal(message, &sender_secret, &recipient_id, nonce_material).unwrap();
        assert!(!sealed.is_empty());

        // Test unsealing (using same keys since it's a test)
        let unsealed = unseal(&sealed, &sender_secret, &recipient_id, nonce_material).unwrap();
        assert_eq!(&*unsealed, message);
    }

    #[test]
    fn test_invalid_keys() {
        let message = b"test";
        let nonce_material = b"nonce";

        // Test with invalid sender secret format
        let result = seal(
            message,
            "invalid_key",
            "sealer_z22222222222222222222222222222222",
            nonce_material,
        );
        assert!(result.is_err());

        // Test with invalid recipient ID format
        let result = seal(
            message,
            "sealerSecret_z11111111111111111111111111111111",
            "invalid_key",
            nonce_material,
        );
        assert!(result.is_err());

        // Test with invalid base58 encoding
        let result = seal(
            message,
            "sealerSecret_z!!!!",
            "sealer_z22222222222222222222222222222222",
            nonce_material,
        );
        assert!(result.is_err());
    }

    #[test]
    fn test_seal_unseal_for_group() {
        // Generate recipient's keypair (the group's sealer)
        let recipient_private = new_x25519_private_key();
        let recipient_public = x25519_public_key(&recipient_private).unwrap();

        // Encode keys with proper prefixes
        let recipient_secret = format!(
            "sealerSecret_z{}",
            bs58::encode(&recipient_private).into_string()
        );
        let recipient_id = format!("sealer_z{}", bs58::encode(&recipient_public).into_string());

        // Test data
        let message = b"Secret message for group";
        let nonce_material = b"test_nonce_material";

        // Test sealing for group (no sender key needed)
        let sealed = seal_for_group(message, &recipient_id, nonce_material).unwrap();

        // Sealed message should be at least 32 bytes (ephemeral public key) + ciphertext
        assert!(sealed.len() > 32);

        // Test unsealing for group
        let unsealed = unseal_for_group(&sealed, &recipient_secret, nonce_material).unwrap();
        assert_eq!(&*unsealed, message);
    }

    #[test]
    fn test_seal_for_group_different_ephemeral_keys() {
        // Generate recipient's keypair
        let recipient_private = new_x25519_private_key();
        let recipient_public = x25519_public_key(&recipient_private).unwrap();

        let recipient_secret = format!(
            "sealerSecret_z{}",
            bs58::encode(&recipient_private).into_string()
        );
        let recipient_id = format!("sealer_z{}", bs58::encode(&recipient_public).into_string());

        let message = b"Test message";
        let nonce_material = b"nonce";

        // Seal twice - should produce different ciphertexts due to different ephemeral keys
        let sealed1 = seal_for_group(message, &recipient_id, nonce_material).unwrap();
        let sealed2 = seal_for_group(message, &recipient_id, nonce_material).unwrap();

        // The first 32 bytes (ephemeral public keys) should be different
        assert_ne!(&sealed1[..32], &sealed2[..32]);

        // But both should decrypt to the same message
        let unsealed1 = unseal_for_group(&sealed1, &recipient_secret, nonce_material).unwrap();
        let unsealed2 = unseal_for_group(&sealed2, &recipient_secret, nonce_material).unwrap();
        assert_eq!(&*unsealed1, message);
        assert_eq!(&*unsealed2, message);
    }

    #[test]
    fn test_unseal_for_group_invalid_input() {
        let recipient_private = new_x25519_private_key();
        let recipient_secret = format!(
            "sealerSecret_z{}",
            bs58::encode(&recipient_private).into_string()
        );

        // Test with too short input
        let result = unseal_for_group(&[0u8; 16], &recipient_secret, b"nonce");
        assert!(result.is_err());

        // Test with invalid recipient secret format
        let result = unseal_for_group(&[0u8; 64], "invalid_secret", b"nonce");
        assert!(result.is_err());
    }
}
