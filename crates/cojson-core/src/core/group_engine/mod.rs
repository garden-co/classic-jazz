//! Group engine: role model, permission comparators, and CoValue key
//! classifiers ported from `packages/cojson/src/permissions.ts` and
//! `packages/cojson/src/coValues/group.ts`.
//!
//! `engine` fuses group validation and read-side role resolution over the
//! `NodeCore` registry; `classify`, `tx_view` and `types` are its foundation.

pub mod classify;
pub mod engine;
pub mod tx_view;
pub mod types;

pub use classify::*;
pub use engine::*;
pub use tx_view::*;
pub use types::*;
