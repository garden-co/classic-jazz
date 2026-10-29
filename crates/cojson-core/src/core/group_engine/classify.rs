//! CoValue key-shape classifiers.
//!
//! Ported from `packages/cojson/src/permissions.ts:583-642`
//! (`isWriteKeyForMember`, `isKeyForKeyField`, `isKeyForAccountField`,
//! `isKeySealedForGroupField`, `isParentExtension`, `isChildExtension`,
//! `isOwnWriteKeyRevelation`), plus:
//! - `packages/cojson/src/typeUtils/accountOrAgentIDfromSessionID.ts`
//!   (`accountOrAgentIDfromSessionID`)
//! - `packages/cojson/src/ids.ts:57-59` (`getParentGroupId`)

use std::collections::HashMap;

/// `isWriteKeyForMember` — permissions.ts:583-587.
pub fn is_write_key_for_member(co: &str) -> bool {
    co.starts_with("writeKeyFor_")
}

/// `getAccountOrAgentFromWriteKeyForMember` — permissions.ts:589-593.
pub fn account_or_agent_from_write_key_for_member(co: &str) -> &str {
    &co["writeKeyFor_".len()..]
}

/// `isKeyForKeyField` — permissions.ts:595-597.
pub fn is_key_for_key_field(co: &str) -> bool {
    co.starts_with("key_") && co.contains("_for_key")
}

/// `isKeyForAccountField` — permissions.ts:599-607. NOTE the odd `||`
/// grouping: `(starts "key_" && (contains "_for_sealer" || "_for_co"))
/// || contains "_for_everyone"` — the `_for_everyone` disjunct is NOT gated
/// by the `key_` prefix check.
pub fn is_key_for_account_field(co: &str) -> bool {
    (co.starts_with("key_") && (co.contains("_for_sealer") || co.contains("_for_co")))
        || co.contains("_for_everyone")
}

/// `isKeySealedForGroupField` — permissions.ts:609-613.
pub fn is_key_sealed_for_group_field(co: &str) -> bool {
    co.starts_with("key_") && co.contains("_sealedFor_sealer")
}

/// `isParentExtension` — permissions.ts:615-617 / `isParentGroupReference`, ids.ts:51-55.
pub fn is_parent_extension(key: &str) -> bool {
    key.starts_with("parent_")
}

/// `isChildExtension` — permissions.ts:619-621 / `isChildGroupReference`, ids.ts:61-63.
pub fn is_child_extension(key: &str) -> bool {
    key.starts_with("child_")
}

/// `isOwnWriteKeyRevelation` — permissions.ts:623-642.
///
/// `key` is either a `${KeyID}_for_${...}` or `${KeyID}_sealedFor_${...}`
/// shape; find the first of `_for_` / `_sealedFor_`, take the prefix as the
/// candidate keyID, and check it against the member's recorded write-only
/// key.
///
/// Deliberate deviation: TS falls through to comparing `key.slice(0, -1)`
/// when neither `_for_` nor `_sealedFor_` is present; this port returns
/// false instead — behaviorally identical for all real key shapes, do not
/// "fix" back.
pub fn is_own_write_key_revelation(
    key: &str,
    member_key: &str,
    write_only_keys: &HashMap<String, String>,
) -> bool {
    let idx = match key.find("_for_") {
        Some(i) => Some(i),
        None => key.find("_sealedFor_"),
    };

    let Some(i) = idx else {
        return false;
    };

    let key_id = &key[..i];

    if key_id.is_empty() {
        return false;
    }

    write_only_keys.get(member_key).map(|s| s.as_str()) == Some(key_id)
}

/// Substring before `"_session"` — `accountOrAgentIDfromSessionID.ts`.
pub fn author_from_session_id(session_id: &str) -> &str {
    match session_id.find("_session") {
        Some(i) => &session_id[..i],
        None => session_id,
    }
}

/// Strip the `"parent_"` prefix — `getParentGroupId`, ids.ts:57-59.
pub fn parent_group_id_from_key(key: &str) -> &str {
    &key["parent_".len()..]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn write_key_for_member() {
        assert!(is_write_key_for_member("writeKeyFor_co_z1"));
        assert!(!is_write_key_for_member("key_z1_for_key_z2"));
        assert_eq!(
            account_or_agent_from_write_key_for_member("writeKeyFor_co_z1"),
            "co_z1"
        );
    }

    #[test]
    fn key_for_key_field() {
        assert!(is_key_for_key_field("key_z1_for_key_z2"));
        assert!(!is_key_for_key_field("key_z1_for_sealer_z1"));
        assert!(!is_key_for_key_field("writeKeyFor_co_z1"));
    }

    #[test]
    fn key_for_account_field() {
        assert!(is_key_for_account_field("key_z1_for_sealer_z1"));
        assert!(is_key_for_account_field("key_z1_for_co_z1"));
        assert!(is_key_for_account_field("key_z1_for_everyone"));
        // the `_for_everyone` disjunct is not gated by the `key_` prefix
        assert!(is_key_for_account_field("anything_for_everyone"));
        assert!(!is_key_for_account_field("key_z1_for_key_z2"));
        assert!(!is_key_for_account_field("writeKeyFor_co_z1"));
    }

    #[test]
    fn key_sealed_for_group_field() {
        assert!(is_key_sealed_for_group_field("key_z1_sealedFor_sealer_z1"));
        assert!(!is_key_sealed_for_group_field("key_z1_for_sealer_z1"));
        assert!(!is_key_sealed_for_group_field("z1_sealedFor_sealer_z1"));
    }

    #[test]
    fn parent_and_child_extension() {
        assert!(is_parent_extension("parent_co_z1"));
        assert!(!is_parent_extension("child_co_z1"));
        assert!(is_child_extension("child_co_z1"));
        assert!(!is_child_extension("parent_co_z1"));
        assert_eq!(parent_group_id_from_key("parent_co_z1"), "co_z1");
    }

    #[test]
    fn own_write_key_revelation() {
        let mut write_only_keys = HashMap::new();
        write_only_keys.insert("co_zMember".to_string(), "key_z1".to_string());

        assert!(is_own_write_key_revelation(
            "key_z1_for_co_zOther",
            "co_zMember",
            &write_only_keys,
        ));
        assert!(is_own_write_key_revelation(
            "key_z1_sealedFor_sealer_zOther",
            "co_zMember",
            &write_only_keys,
        ));
        // wrong keyID
        assert!(!is_own_write_key_revelation(
            "key_z2_for_co_zOther",
            "co_zMember",
            &write_only_keys,
        ));
        // member has no recorded write-only key
        assert!(!is_own_write_key_revelation(
            "key_z1_for_co_zOther",
            "co_zUnknown",
            &write_only_keys,
        ));
        // no `_for_`/`_sealedFor_` marker at all
        assert!(!is_own_write_key_revelation(
            "key_z1",
            "co_zMember",
            &write_only_keys,
        ));
        // empty keyID prefix (marker at position 0)
        assert!(!is_own_write_key_revelation(
            "_for_co_zOther",
            "co_zMember",
            &write_only_keys,
        ));
    }

    #[test]
    fn author_from_session_id_strips_suffix() {
        assert_eq!(author_from_session_id("co_zA_session_z123"), "co_zA");
        assert_eq!(
            author_from_session_id("sealer_zA/signer_zB_session_z1"),
            "sealer_zA/signer_zB"
        );
    }
}
