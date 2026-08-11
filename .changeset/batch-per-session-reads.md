---
"cojson": patch
---

Batch the per-session reads in the SQLite storage load path. Loading a coValue issued one `signatureAfter` query and one `transactions` query per session — `2 + 2 * sessions` reads — so cost scaled with the number of writers rather than the amount of content. Both are now a single query per coValue, making a load a flat 4 reads.
