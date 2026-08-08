---
"cojson": patch
---

Performance: faster processing of large CoMaps — per-key op histories skip
re-sorting when new ops arrive in order, and `keys()` is maintained
incrementally instead of re-scanning every key on each update.
