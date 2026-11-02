---
"cojson": patch
---

Discard staged transactions when adding transactions to a session fails. Previously, transactions rejected by signature verification stayed staged, so every later add for that session was hashed against them (rejecting valid content), a later unverified add from storage could commit them, and repeated retries grew WASM memory without bound until allocations failed with `RuntimeError: unreachable`.
