---
"cojson": patch
---

Batch the checkpoint reads when loading a streaming coValue from SQLite storage. A coValue long enough to be split across signature checkpoints was read one checkpoint at a time — a round trip per ~100KB of transaction log, so a coValue with tens of thousands of transactions cost tens of sequential reads. Checkpoints are now read several at a time and sliced in memory, keeping peak memory bounded.
