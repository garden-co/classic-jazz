---
"cojson": patch
"cojson-core-rn": patch
---

Native NodeCore for the React Native binding: RNCrypto now runs
group/permission validation and role resolution natively (same engine as
napi/wasm). RN error messages now pass through the inner error verbatim
(previously prefixed with "SessionMap error: "), preserving the error
contracts the TypeScript layer matches on.
