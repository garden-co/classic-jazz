---
"cojson": patch
---

Performance: faster CoStream and FileStream processing — per-session stream
histories skip re-sorting when items arrive in order, and binary chunks are
decoded incrementally instead of re-decoding the whole file on every read.
