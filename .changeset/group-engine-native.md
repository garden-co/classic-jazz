---
"cojson": patch
"cojson-core-napi": patch
---

Move group/account permission validation and role resolution into the native
NodeCore (napi), behind capability detection — wasm/RN keep the TypeScript
path until their native ports land. Adds a fixture corpus generated from the
TypeScript implementation and a randomized differential test harness.
