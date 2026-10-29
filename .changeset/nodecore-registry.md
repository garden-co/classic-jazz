---
"cojson": patch
"cojson-core-napi": patch
---

Introduce a node-level NodeCore registry owning all per-CoValue session state
(native in napi; TS shim over per-CoValue session maps for wasm/RN). No
behavior change; groundwork for moving permissions and group state into the
Rust core.
