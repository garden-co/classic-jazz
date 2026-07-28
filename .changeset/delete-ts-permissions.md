---
"cojson": patch
---

Remove the TypeScript permission-validation engine, the capability shim, and
the native-validation kill switch. All providers (Napi/Wasm/RN) now validate
transactions and resolve roles natively — `createNodeCore()` is abstract, and
`validateTransactions`/`roleOf`/`resetValidation` are required on `NodeCoreImpl`.
`determineValidTransactions` is now an unconditional native call.

A minimal TypeScript role-read path is kept only for branch/frontier CoMap
views, which the native engine has no `atTime`-only equivalent for yet. The
differential test harness (whose TS oracle is gone) is removed; the group-engine
fixtures are now frozen golden files that regeneration must reproduce
byte-for-byte in verdict content.
