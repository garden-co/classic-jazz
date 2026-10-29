//! Role model, permission comparators, and time-indexed entries.
//!
//! Ported from:
//! - `packages/cojson/src/permissions.ts:171-181` (`isHigherRole`)
//! - `packages/cojson/src/coValues/group.ts:1681-1727`
//!   (`isInheritableRole`, `isMorePermissiveAndShouldInherit`)
//! - `packages/cojson/src/coValues/group.ts:254-286` (`TimeBasedEntry`)
//! - `packages/cojson/src/coValues/group.ts:92-98` (`ParentGroupReferenceRole`)

use serde::{Deserialize, Serialize};

/// A member's role in a group. Mirrors TS `Role` (permissions.ts:28-57).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum Role {
    #[serde(rename = "admin")]
    Admin,
    #[serde(rename = "manager")]
    Manager,
    #[serde(rename = "writer")]
    Writer,
    #[serde(rename = "reader")]
    Reader,
    #[serde(rename = "writeOnly")]
    WriteOnly,
    #[serde(rename = "revoked")]
    Revoked,
    #[serde(rename = "adminInvite")]
    AdminInvite,
    #[serde(rename = "managerInvite")]
    ManagerInvite,
    #[serde(rename = "writerInvite")]
    WriterInvite,
    #[serde(rename = "readerInvite")]
    ReaderInvite,
    #[serde(rename = "writeOnlyInvite")]
    WriteOnlyInvite,
}

impl Role {
    /// Parse the exact TS string form of a role. Returns `None` for anything else.
    pub fn parse(s: &str) -> Option<Role> {
        match s {
            "admin" => Some(Role::Admin),
            "manager" => Some(Role::Manager),
            "writer" => Some(Role::Writer),
            "reader" => Some(Role::Reader),
            "writeOnly" => Some(Role::WriteOnly),
            "revoked" => Some(Role::Revoked),
            "adminInvite" => Some(Role::AdminInvite),
            "managerInvite" => Some(Role::ManagerInvite),
            "writerInvite" => Some(Role::WriterInvite),
            "readerInvite" => Some(Role::ReaderInvite),
            "writeOnlyInvite" => Some(Role::WriteOnlyInvite),
            _ => None,
        }
    }

    /// The exact TS string form of this role (inverse of [`Role::parse`]).
    pub fn as_str(&self) -> &'static str {
        match self {
            Role::Admin => "admin",
            Role::Manager => "manager",
            Role::Writer => "writer",
            Role::Reader => "reader",
            Role::WriteOnly => "writeOnly",
            Role::Revoked => "revoked",
            Role::AdminInvite => "adminInvite",
            Role::ManagerInvite => "managerInvite",
            Role::WriterInvite => "writerInvite",
            Role::ReaderInvite => "readerInvite",
            Role::WriteOnlyInvite => "writeOnlyInvite",
        }
    }

    /// `isAccountRole` — permissions.ts:59-67. True for the five non-invite,
    /// non-revoked "concrete account" roles.
    pub fn is_account_role(role: Option<Role>) -> bool {
        matches!(
            role,
            Some(Role::Manager)
                | Some(Role::Admin)
                | Some(Role::Writer)
                | Some(Role::Reader)
                | Some(Role::WriteOnly)
        )
    }

    /// `canAdmin` — permissions.ts:69-71.
    pub fn can_admin(role: Option<Role>) -> bool {
        matches!(role, Some(Role::Admin) | Some(Role::Manager))
    }

    /// `isInheritableRole` — group.ts:1681-1691.
    pub fn is_inheritable(role: Option<Role>) -> bool {
        matches!(
            role,
            Some(Role::Revoked)
                | Some(Role::Admin)
                | Some(Role::Manager)
                | Some(Role::Writer)
                | Some(Role::Reader)
        )
    }
}

/// Validation-side comparator — `isHigherRole`, permissions.ts:171-181.
///
/// Is `a` higher than `b`? `revoked` is never higher than anything (including
/// another `revoked`/`undefined`).
///
/// NOTE: TS also has a leading `a === undefined` check; `a` is not optional
/// here (the TS signature takes `Role`, not `Role | undefined`, for `a`), so
/// that branch is dropped as unreachable — everything else is a literal,
/// branch-for-branch port.
pub fn is_higher_role(a: Role, b: Option<Role>) -> bool {
    if a == Role::Revoked {
        return false;
    }
    if b.is_none() || b == Some(Role::Revoked) {
        return true;
    }
    if b == Some(Role::Admin) {
        return false;
    }
    if a == Role::Admin {
        return true;
    }
    if b == Some(Role::Manager) {
        return false;
    }
    if a == Role::Manager {
        return true;
    }
    a == Role::Writer && b == Some(Role::Reader)
}

/// Read-side comparator — `isMorePermissiveAndShouldInherit`, group.ts:1693-1727.
///
/// NOTE: a `revoked` role in the parent returns `true` — an inherited
/// `revoked` OVERRIDES the child role. This differs from the validation-side
/// comparator above, where `revoked` is never higher. Callers rarely reach
/// this branch (see porter notes), but the table is ported exactly as
/// written.
pub fn is_more_permissive_and_should_inherit(
    role_in_parent: Role,
    role_in_child: Option<Role>,
) -> bool {
    if role_in_parent == Role::Revoked {
        return true;
    }

    if role_in_parent == Role::Manager {
        return role_in_child.is_none()
            || (role_in_child != Some(Role::Manager) && role_in_child != Some(Role::Admin));
    }

    if role_in_parent == Role::Admin {
        return role_in_child.is_none() || role_in_child != Some(Role::Admin);
    }

    if role_in_parent == Role::Writer {
        return role_in_child.is_none()
            || role_in_child == Some(Role::Reader)
            || role_in_child == Some(Role::WriteOnly);
    }

    if role_in_parent == Role::Reader {
        return role_in_child.is_none();
    }

    // writeOnly can't be inherited
    if role_in_parent == Role::WriteOnly {
        return false;
    }

    false
}

/// A parent-group reference role — `ParentGroupReferenceRole`, group.ts:92-98.
/// Parsed from the `parent_<id>` change value: `"extend"` | a capped role
/// string | `"revoked"`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum ParentRoleMapping {
    Extend,
    Capped(Role),
    Revoked,
}

/// A time-indexed history of values, keyed by `madeAt` timestamp.
/// Ported from `TimeBasedEntry`, group.ts:254-286.
#[derive(Debug, Clone)]
pub struct TimeBasedEntry<T> {
    changes: Vec<(u64, T)>,
}

impl<T> TimeBasedEntry<T> {
    pub fn new() -> Self {
        TimeBasedEntry {
            changes: Vec::new(),
        }
    }

    /// Insert a change in chronological order. Search backwards from the end
    /// so that an equal `made_at` inserts AFTER existing equals (TS scans
    /// `> madeAt`, stopping — and thus inserting — at the first entry that is
    /// not strictly greater).
    pub fn add_change(&mut self, made_at: u64, value: T) {
        let mut idx = self.changes.len();
        while idx > 0 && self.changes[idx - 1].0 > made_at {
            idx -= 1;
        }
        self.changes.insert(idx, (made_at, value));
    }

    pub fn get_latest(&self) -> Option<&T> {
        self.changes.last().map(|(_, v)| v)
    }

    /// `getAtTime` — `None` (TS `undefined`) means "latest"; otherwise the
    /// last change with `made_at <= at_time` (TS `findLast`).
    pub fn get_at_time(&self, at_time: Option<u64>) -> Option<&T> {
        match at_time {
            None => self.get_latest(),
            Some(t) => self
                .changes
                .iter()
                .rev()
                .find(|(m, _)| *m <= t)
                .map(|(_, v)| v),
        }
    }

    /// The last stored value whose payload satisfies `pred` (TS `findLast`).
    /// Used by the coMap frontier filter, which tests each op's own `txID`
    /// (carried in the value) rather than its `made_at`.
    pub fn find_last<F: Fn(&T) -> bool>(&self, pred: F) -> Option<&T> {
        self.changes
            .iter()
            .rev()
            .find(|(_, v)| pred(v))
            .map(|(_, v)| v)
    }

    /// Values in stored (chronological, `compareTransactions`) order — the
    /// order `editsAt` yields and the order a rich delta serializes a key's
    /// op-list in.
    pub fn iter_values(&self) -> impl Iterator<Item = &T> {
        self.changes.iter().map(|(_, v)| v)
    }
}

impl<T> Default for TimeBasedEntry<T> {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn role_round_trips_every_ts_string() {
        let cases = [
            (Role::Admin, "admin"),
            (Role::Manager, "manager"),
            (Role::Writer, "writer"),
            (Role::Reader, "reader"),
            (Role::WriteOnly, "writeOnly"),
            (Role::Revoked, "revoked"),
            (Role::AdminInvite, "adminInvite"),
            (Role::ManagerInvite, "managerInvite"),
            (Role::WriterInvite, "writerInvite"),
            (Role::ReaderInvite, "readerInvite"),
            (Role::WriteOnlyInvite, "writeOnlyInvite"),
        ];
        for (role, s) in cases {
            assert_eq!(Role::parse(s), Some(role), "parse({s:?})");
            assert_eq!(role.as_str(), s, "as_str({role:?})");
            // serde round trip too
            let json = serde_json::to_string(&role).unwrap();
            assert_eq!(json, format!("\"{s}\""));
            let back: Role = serde_json::from_str(&json).unwrap();
            assert_eq!(back, role);
        }
        assert_eq!(Role::parse("nonsense"), None);
    }

    #[test]
    fn is_account_role_matches_ts_table() {
        assert!(Role::is_account_role(Some(Role::Manager)));
        assert!(Role::is_account_role(Some(Role::Admin)));
        assert!(Role::is_account_role(Some(Role::Writer)));
        assert!(Role::is_account_role(Some(Role::Reader)));
        assert!(Role::is_account_role(Some(Role::WriteOnly)));
        assert!(!Role::is_account_role(Some(Role::Revoked)));
        assert!(!Role::is_account_role(Some(Role::AdminInvite)));
        assert!(!Role::is_account_role(Some(Role::ManagerInvite)));
        assert!(!Role::is_account_role(Some(Role::WriterInvite)));
        assert!(!Role::is_account_role(Some(Role::ReaderInvite)));
        assert!(!Role::is_account_role(Some(Role::WriteOnlyInvite)));
        assert!(!Role::is_account_role(None));
    }

    #[test]
    fn can_admin_matches_ts_table() {
        assert!(Role::can_admin(Some(Role::Admin)));
        assert!(Role::can_admin(Some(Role::Manager)));
        for role in [
            Role::Writer,
            Role::Reader,
            Role::WriteOnly,
            Role::Revoked,
            Role::AdminInvite,
            Role::ManagerInvite,
            Role::WriterInvite,
            Role::ReaderInvite,
            Role::WriteOnlyInvite,
        ] {
            assert!(!Role::can_admin(Some(role)), "{role:?}");
        }
        assert!(!Role::can_admin(None));
    }

    #[test]
    fn is_inheritable_role_matches_ts_table() {
        for role in [
            Role::Revoked,
            Role::Admin,
            Role::Manager,
            Role::Writer,
            Role::Reader,
        ] {
            assert!(Role::is_inheritable(Some(role)), "{role:?}");
        }
        for role in [
            Role::WriteOnly,
            Role::AdminInvite,
            Role::ManagerInvite,
            Role::WriterInvite,
            Role::ReaderInvite,
            Role::WriteOnlyInvite,
        ] {
            assert!(!Role::is_inheritable(Some(role)), "{role:?}");
        }
        assert!(!Role::is_inheritable(None));
    }

    // Table-driven test of is_higher_role over every (a, b) role pair plus
    // b = None, mirroring permissions.ts:171-181 branch by branch.
    #[test]
    fn is_higher_role_covers_every_branch() {
        const ALL: [Role; 11] = [
            Role::Admin,
            Role::Manager,
            Role::Writer,
            Role::Reader,
            Role::WriteOnly,
            Role::Revoked,
            Role::AdminInvite,
            Role::ManagerInvite,
            Role::WriterInvite,
            Role::ReaderInvite,
            Role::WriteOnlyInvite,
        ];

        fn expected(a: Role, b: Option<Role>) -> bool {
            if a == Role::Revoked {
                return false;
            }
            if b.is_none() || b == Some(Role::Revoked) {
                return true;
            }
            if b == Some(Role::Admin) {
                return false;
            }
            if a == Role::Admin {
                return true;
            }
            if b == Some(Role::Manager) {
                return false;
            }
            if a == Role::Manager {
                return true;
            }
            a == Role::Writer && b == Some(Role::Reader)
        }

        for a in ALL {
            assert_eq!(is_higher_role(a, None), expected(a, None), "a={a:?} b=None");
            for b in ALL {
                assert_eq!(
                    is_higher_role(a, Some(b)),
                    expected(a, Some(b)),
                    "a={a:?} b={b:?}"
                );
            }
        }

        // Spot checks pinned to the literal TS table, independent of the
        // `expected` mirror above.
        assert!(!is_higher_role(Role::Revoked, None));
        assert!(!is_higher_role(Role::Revoked, Some(Role::Reader)));
        assert!(is_higher_role(Role::Admin, None));
        assert!(is_higher_role(Role::Admin, Some(Role::Revoked)));
        assert!(!is_higher_role(Role::Manager, Some(Role::Admin)));
        assert!(is_higher_role(Role::Admin, Some(Role::Manager)));
        assert!(is_higher_role(Role::Manager, Some(Role::Writer)));
        assert!(is_higher_role(Role::Writer, Some(Role::Reader)));
        assert!(!is_higher_role(Role::Reader, Some(Role::Writer)));
        assert!(!is_higher_role(Role::Writer, Some(Role::WriteOnly)));

        // Literal, TS-derived spot check independent of `expected`: b ==
        // manager falls through to the `false` branch (permissions.ts:171-181).
        assert!(!is_higher_role(Role::Writer, Some(Role::Manager)));
    }

    // Table-driven test of is_more_permissive_and_should_inherit over every
    // (parent, child) role pair plus child = None, mirroring
    // group.ts:1693-1727 branch by branch, INCLUDING the revoked -> true case.
    #[test]
    fn is_more_permissive_and_should_inherit_covers_every_branch() {
        const ALL: [Role; 11] = [
            Role::Admin,
            Role::Manager,
            Role::Writer,
            Role::Reader,
            Role::WriteOnly,
            Role::Revoked,
            Role::AdminInvite,
            Role::ManagerInvite,
            Role::WriterInvite,
            Role::ReaderInvite,
            Role::WriteOnlyInvite,
        ];

        fn expected(parent: Role, child: Option<Role>) -> bool {
            if parent == Role::Revoked {
                return true;
            }
            if parent == Role::Manager {
                return child.is_none()
                    || (child != Some(Role::Manager) && child != Some(Role::Admin));
            }
            if parent == Role::Admin {
                return child.is_none() || child != Some(Role::Admin);
            }
            if parent == Role::Writer {
                return child.is_none()
                    || child == Some(Role::Reader)
                    || child == Some(Role::WriteOnly);
            }
            if parent == Role::Reader {
                return child.is_none();
            }
            if parent == Role::WriteOnly {
                return false;
            }
            false
        }

        for parent in ALL {
            assert_eq!(
                is_more_permissive_and_should_inherit(parent, None),
                expected(parent, None),
                "parent={parent:?} child=None"
            );
            for child in ALL {
                assert_eq!(
                    is_more_permissive_and_should_inherit(parent, Some(child)),
                    expected(parent, Some(child)),
                    "parent={parent:?} child={child:?}"
                );
            }
        }

        // The revoked -> true case, called out explicitly by the task: an
        // inherited `revoked` role in the parent OVERRIDES the child role,
        // even a child `admin`.
        assert!(is_more_permissive_and_should_inherit(
            Role::Revoked,
            Some(Role::Admin)
        ));
        assert!(is_more_permissive_and_should_inherit(Role::Revoked, None));

        // A few literal spot checks pinned to the TS source.
        assert!(!is_more_permissive_and_should_inherit(
            Role::Manager,
            Some(Role::Admin)
        ));
        assert!(!is_more_permissive_and_should_inherit(
            Role::Admin,
            Some(Role::Admin)
        ));
        assert!(is_more_permissive_and_should_inherit(
            Role::Writer,
            Some(Role::Reader)
        ));
        assert!(!is_more_permissive_and_should_inherit(
            Role::Writer,
            Some(Role::Writer)
        ));
        assert!(!is_more_permissive_and_should_inherit(
            Role::Reader,
            Some(Role::Reader)
        ));
        assert!(!is_more_permissive_and_should_inherit(
            Role::WriteOnly,
            None
        ));

        // Literal, TS-derived spot checks independent of `expected`, pinning
        // group.ts:1693-1727 branch by branch.
        assert!(is_more_permissive_and_should_inherit(
            Role::Manager,
            Some(Role::Writer)
        ));
        assert!(is_more_permissive_and_should_inherit(
            Role::Admin,
            Some(Role::Writer)
        ));
        assert!(is_more_permissive_and_should_inherit(Role::Reader, None));
        // invite fallthrough -> false
        assert!(!is_more_permissive_and_should_inherit(
            Role::AdminInvite,
            Some(Role::Reader)
        ));
    }

    #[test]
    fn time_based_entry_matches_ts_semantics() {
        let mut e = TimeBasedEntry::new();
        e.add_change(10, "a");
        e.add_change(30, "c");
        e.add_change(20, "b"); // out-of-order insert lands in the middle
        assert_eq!(e.get_at_time(Some(15)), Some(&"a"));
        assert_eq!(e.get_at_time(Some(20)), Some(&"b"));
        assert_eq!(e.get_at_time(None), Some(&"c")); // None = latest
        assert_eq!(e.get_at_time(Some(5)), None);
        // equal madeAt inserts AFTER existing equals (TS scans `> madeAt`)
        e.add_change(20, "b2");
        assert_eq!(e.get_at_time(Some(20)), Some(&"b2"));
        assert_eq!(e.get_latest(), Some(&"c"));
    }

    #[test]
    fn time_based_entry_empty_returns_none() {
        let e: TimeBasedEntry<&str> = TimeBasedEntry::new();
        assert_eq!(e.get_latest(), None);
        assert_eq!(e.get_at_time(None), None);
        assert_eq!(e.get_at_time(Some(0)), None);
    }
}
