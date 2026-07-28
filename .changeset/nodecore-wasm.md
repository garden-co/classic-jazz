---
"cojson": patch
"cojson-core-wasm": patch
---

Native NodeCore for the wasm binding: WasmCrypto now runs group/permission
validation and role resolution natively (same engine as napi), replacing the
TypeScript shim. Also fixes a latent verdict-application bug shared with the
napi path: verdicts are now scoped per ruleset (full history for groups so
flips reach processed transactions; delta for owned covalues to preserve
first-writer-wins invalidations).
