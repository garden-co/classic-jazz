---
"jazz-tools": patch
---

Route OP-SQLite reads through op-sqlite's synchronous JSI path where it is available. Its native thread pool is hardcoded to a single thread, so async reads gained no parallelism and paid for a thread hop plus a promise round-trip each. Measured on a cold covalue-load storm: 2.36x lower wall time and 20.5x lower p95. Reads inside a transaction and older op-sqlite versions without `executeSync` keep the async path.
