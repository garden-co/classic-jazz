# Implementation Tasks

## Tasks

### Layer 1: Types and ID Infrastructure

- [ ] 1. Add `CompressionSessionID` type and `isCompressionSessionID()` guard to `ids.ts`
  - Add type `CompressionSessionID = \`${RawAccountID | AgentID}_session_z${string}@\``
  - Add `isCompressionSessionID()` function checking for `@` suffix via `charCodeAt`
  - Ref: Design §1 — Compression Session ID Format

- [ ] 2. Add `CompressionMeta`, `CompressedSession`, `CompressedTx` interfaces
  - `CompressionMeta` with `compressed.sessions`, `compressed.encoding` (compression timestamp comes from the transaction's own `madeAt`)
  - `CompressedSession` with `sessionID`, `lastSignature`, `transactions`
  - `CompressedTx` with `madeAt`, `changes`, `meta?`
  - Add error types: `CompressionTransactionRejectedError`, `CompressedSessionRejectedError`
  - Ref: Design §2 — Compression Transaction Structure, Data Models

- [ ] 3. Add `newCompressionSessionID()` to `CryptoProvider` in `crypto.ts`
  - Generate session ID with format `${accountID}_session_z${base58(randomBytes(7))}@`
  - Add to all crypto provider implementations (NAPI, WASM, RN)
  - Ref: Design §1 — Compression Session ID Format

### Layer 2: Rust cojson-core — Compressed Session Tracking and LZ4

- [ ] 4. Add `compressed_sessions` map and `mark_sessions_as_compressed()` to Rust `SessionMapImpl`
  - `compressed_sessions: HashMap<SessionID, u64>` tracking compressed session ID → txCount
  - `mark_sessions_as_compressed()` with late-transaction guard: skip marking if `currentTxCount > txCount`
  - Use `max()` for concurrent compression merges
  - Add `is_session_compressed()` check
  - Expose via WASM, NAPI, and RN bindings
  - Ref: Design §6 — Session Pruning and KnownState

- [ ] 5. Modify `get_known_state()` in Rust `SessionMapImpl` to include compressed sessions
  - Merge `compressed_sessions` map into the known state result automatically
  - Use `max(existing, txCount)` for each compressed session
  - No TypeScript-side merging needed — `knownState()` just delegates to Rust
  - Ref: Design §6 — KnownState merging

- [ ] 6. Modify `getSessions()` and `newContentSince()` in `VerifiedState` to exclude compressed sessions
  - `getSessions()`: skip sessions where `isSessionCompressed(sessionID)` is true (delegates to Rust)
  - `newContentSince()`: same exclusion — compressed session data lives in the blob, not in individual sessions
  - Ref: Design §6 — getSessions and newContentSince

- [ ] 7. Add `isStreaming()` overload with `excludeCompressionSessions` option to `VerifiedState`
  - Accept `{ excludeCompressionSessions: boolean }` option
  - When provided, iterate streaming known state and skip sessions with `@` suffix (`isCompressionSessionID`) when checking if streaming is complete
  - Ref: Design §5 — Streaming state management

### Layer 3: CoValueCore — Compression Execution and Ingestion

- [ ] 8. Add `isStreaming({ excludeCompressionSessions })` option to `CoValueCore`
  - Delegate to `VerifiedState.isStreaming({ excludeCompressionSessions: true })` which skips all `@`-suffix compression sessions
  - This excludes compression sessions (the ones ending with `@`), not the compressed sessions (the originals that got compressed)
  - Ref: Design §5 — Streaming state management

- [ ] 9. Add `makeCompressionTransaction()` to `CoValueCore`
  - Create a trusting transaction on a compression session (no encryption, no signature chain from existing sessions)
  - Accept `compressionSessionID`, `changes`, optional `meta`, and `madeAt`
  - Similar to existing `makeTransaction` but for the compression session
  - Ref: Design §4 — Compression Execution Flow (step 3)

- [ ] 10. Add `validateCompressionPermissions()` to `CoValueCore`
  - Check: `this.verified` exists, `this.isGroup()`, `group.myRole() === "admin"`
  - Return `{ ok: true }` or `{ ok: false, reason, message }`
  - Ref: Design §4 — Compression Execution Flow

- [ ] 11. Add `compressGroup(sessionIDs)` to `CoValueCore`
  - Call `validateCompressionPermissions()`
  - Iterate session IDs, check eligibility via `isSessionEligibleForCompression()`
  - Collect session logs, build `CompressedSession[]` payload
  - LZ4-compress and base64-encode the JSON payload
  - Split encoded string across multiple transactions if exceeding `MAX_RECOMMENDED_TX_SIZE`
  - First transaction carries `CompressionMeta` (with `madeAt`), subsequent ones carry plain string chunks
  - Call `markSessionsAsCompressed()`
  - Ref: Design §4 — Compression Execution Flow

- [ ] 12. Add `#isCompressionTransaction()` detection in `tryAddTransactions`
  - Check `isCompressionSessionID(sessionID)` early in `tryAddTransactions`
  - Reject if not a group
  - If `isStreaming({ excludeCompressionSessions: true })`, park the transaction and return `{ value: true, parked: true }`
  - Otherwise return `{ value: true }` to proceed to validation
  - Ref: Design §5 — Phase 1: Detect and park

- [ ] 13. Add compression transaction parking and dequeue mechanism
  - `parkCompressionTransaction()`: store sessionID, transactions, and compressionMeta in a queue
  - Dequeue and validate parked transactions when streaming completes (i.e., when `isStreaming({ excludeCompressionSessions: true })` becomes `false`)
  - Integrate dequeue check into existing streaming completion callbacks
  - Ref: Design §5 — Phase 1 and Phase 2

- [ ] 14. Add `#validateCompressionTransaction()` for ingestion-time validation
  - Check 1: Author must be admin at compression time via `roleOfAt(authorAccountID, transaction.madeAt)`
  - Check 2: No duplicate sessions in `compressionMeta.compressed.sessions`
  - Check 3: All compressed session owners must have eligible roles at compression time via `roleOfAt()`
  - On success: add transaction to `SessionMapImpl`, call `markSessionsAsCompressed()`
  - On failure: reject the transaction, do not add to session map
  - Ref: Design §5 — Phase 2: Validate and accept

- [ ] 15. Add `roleOfAt()` method to `RawGroup`
  - Resolve the role of an account/agent at a specific point in time
  - Walk the role assignment history chronologically up to `madeAt`
  - Used by compression validation to ensure deterministic results regardless of transaction arrival order
  - Ref: Design §5 — Phase 2 (role-at-time lookup)

- [ ] 16. Reject late transactions on compressed sessions in `tryAddTransactions`
  - Early check: if `this.verified.isSessionCompressed(sessionID)`, return `CompressedSessionRejected` error
  - Ref: Design §8 — Handling Late Transactions on Compressed Sessions

### Layer 4: RawGroup — Eligibility and Decompression

- [ ] 17. Add `isSessionEligibleForCompression()` and `getEligibleSessionsForCompression()` to `group.ts`
  - `isSessionEligibleForCompression()`: check role of session owner (account or agent) via `group.roleOf()` — exclude admin, manager, all invite roles
  - `getEligibleSessionsForCompression()`: iterate sessions, skip compression and delete sessions, collect eligible ones
  - Ref: Design §3 — Session Eligibility Detection

- [ ] 18. Add `pendingCompressedBlobs` and `isDecompressed` state to `RawGroup`
  - `pendingCompressedBlobs: { payload: string; compressionSessionID: SessionID }[]`
  - `isDecompressed: boolean`
  - Ref: Design §7.1 — Storage in RawGroup

- [ ] 19. Override `handleNewTransaction()` in `RawGroup` to intercept compression transactions
  - Detect compression session via `isCompressionSessionID(transaction.txID.sessionID)`
  - Accumulate string chunks from compression transactions into `pendingCompressedBlobs`
  - Concatenate chunks in session order
  - Return early — don't process as regular transaction
  - Ref: Design §7.1 — handleNewTransaction override

- [ ] 20. Add `decompressIfNeeded()` to `RawGroup`
  - Guard: return early if already decompressed or no pending blobs
  - For each blob: base64-decode → LZ4-decompress → JSON-parse into `CompressedSession[]`
  - Enforce `MAX_DECOMPRESSED_SIZE` (50MB) — skip blob with error log if exceeded
  - Process each session via `processDecompressedTransactions()`
  - Clear `pendingCompressedBlobs` after processing
  - Ref: Design §7.2 — Triggering Decompression

- [ ] 21. Add `processDecompressedTransactions()` to `RawGroup`
  - Iterate transactions with sequential `txIndex`, changes with sequential `changeIdx`
  - Build MapOps using original `session.sessionID` and original `madeAt` (behaves like merged transactions)
  - Insert into `this.ops` and update `this.latest`
  - Update caches: parent group references and key revelations
  - Ref: Design §7.2 — processDecompressedTransactions

- [ ] 22. Integrate `decompressIfNeeded()` into key lookup methods in `RawGroup`
  - `getReadKey()`: try current state first, if not found call `decompressIfNeeded()` and retry
  - Similarly for: `findKeyRevelation` methods, `getParentGroups`, and any other entry lookup methods
  - Ref: Design §7.3 — Integration Points

### Layer 5: Permissions

- [ ] 23. Add compression session bypass in `determineValidTransactionsForGroup`
  - When processing a transaction from a `CompressionSessionID`, call `transaction.markValid()` and `continue`
  - No additional checks — validation is fully handled by `tryAddTransactions`
  - Ref: Design §5 — Permissions: determineValidTransactionsForGroup

### Layer 6: Storage Layer

- [ ] 24. Modify storage `loadCoValue()` to filter out compressed sessions
  - Scan sessions for compression session IDs (`isCompressionSessionID`)
  - For each compression session, read its first transaction's meta to extract `compressed.sessions`
  - Build a `Set<SessionID>` of compressed sessions
  - Skip those sessions when constructing `NewContentMessage` chunks
  - Apply to both `storageAsync.ts` and `storageSync.ts`
  - Ref: Design §6a — Storage Layer: Loading from Storage

### Layer 7: Re-Compression

- [ ] 25. Add `recompressGroup()` to `CoValueCore`
  - Handle two cases: existing compression sessions (decompress old blob, filter stale sessions) and regular sessions
  - Stale session filter: skip sessions where `currentTxCount > oldSession.transactions.length`
  - Mark old compression session itself as compressed in the new meta
  - Merge old + new sessions into a single new compression payload
  - Create new compression transaction with merged payload
  - Ref: Design §9a — Re-Compressing a Compressed Session

### Layer 8: LZ4 Integration (Rust cojson-core)

- [ ] 26. Add LZ4 compression/decompression to Rust `cojson-core` crate
  - Implement `lz4_compress(data: &[u8]) -> Vec<u8>` and `lz4_decompress(data: &[u8]) -> Result<Vec<u8>, Error>` in Rust
  - Add `lz4` crate dependency in `cojson-core`
  - Expose via WASM, NAPI, and RN bindings
  - Ensure decompression fails gracefully for corrupted data
  - TypeScript `CryptoProvider` gains `lz4Compress(data: Uint8Array): Uint8Array` and `lz4Decompress(data: Uint8Array): { ok: boolean; data: Uint8Array }` that delegate to the Rust implementation
  - Add base64 encode/decode helpers if not already available
  - Add `splitString(str: string, maxSize: number): string[]` helper for chunking
  - Ref: Design §2 — Payload compression, §7.2 — decompressIfNeeded

### Layer 9: Inspector UI

- [ ] 27. Add `getTotalTransactionCount()` helper for `RawGroup`
  - Sum transaction counts across all sessions
  - Used by the Inspector UI to determine button visibility (>2000 threshold)
  - Ref: Design §10 — Inspector UI

- [ ] 28. Add `hasCompressionSession()` helper
  - Iterate sessions and check for any `CompressionSessionID`
  - Used by the Inspector UI to determine button enabled/disabled state
  - Ref: Design §10 — Inspector UI

- [ ] 29. Add "Compress Group" button to Inspector group detail view
  - **Visible**: only when `isAdmin && totalTxCount > 2000`
  - **Enabled**: when no existing compression sessions and not already clicked
  - **Disabled states**: "Already compressed" (existing compression) or "Compressed" (just clicked)
  - On click: call `getEligibleSessionsForCompression()` → `group.core.compressGroup(eligible)`
  - Ref: Design §10 — Inspector UI

### Layer 10: Tests

- [ ] 30. Test: compression preserves group state after decompression
  - Create group, add members (creating key revelations)
  - Compress eligible sessions
  - Verify session count decreases
  - Trigger decompression via key lookup, verify state matches pre-compression
  - Ref: Design — Test 1

- [ ] 31. Test: compressed sessions excluded from sync content but included in KnownState
  - Create group, compress eligible sessions
  - Verify `knownState()` includes compressed sessions with correct tx counts
  - Verify `newContentSince()` excludes compressed sessions
  - Ref: Design — Test 2

- [ ] 32. Test: late transactions on compressed sessions are rejected
  - Create group, compress sessions
  - Attempt `tryAddTransactions` on a compressed session
  - Verify `CompressedSessionRejected` error is returned
  - Ref: Design — Test 3

- [ ] 33. Test: role-based eligibility excludes admin/manager/invite sessions
  - Create group with admin, manager, and writer members
  - Verify admin and manager sessions are not eligible
  - Verify writer sessions are eligible
  - Verify agent sessions with invite roles are not eligible
  - Ref: Design — Test 4

- [ ] 34. Test: on-demand decompression is lazy — only triggered on data lookup
  - Compress eligible sessions
  - Verify `pendingCompressedBlobs` is populated
  - Trigger decompression via key lookup
  - Verify blobs are cleared and `isDecompressed` is true
  - Ref: Design — Test 5

- [ ] 35. Test: concurrent compressions from two admins both apply
  - Setup two admins, multiple writer members
  - Each admin compresses overlapping session sets
  - Sync both to a third node
  - Verify all compressed sessions are pruned
  - Verify decompressed state matches original
  - Ref: Design — Test 6

- [ ] 36. Test: compression validation rejects non-admin authors
  - Create a compression transaction from a writer account
  - Verify `#validateCompressionTransaction` rejects it

- [ ] 37. Test: compression validation uses role-at-time (not current role)
  - Create a group, add a writer, compress writer's sessions
  - Promote the writer to admin before ingesting the compression on a second node
  - Verify the compression is still accepted (writer role at compression time)

- [ ] 38. Test: markSessionsAsCompressed skips sessions with more transactions than compressed
  - Create a session with 5 transactions, compress at txCount=5
  - Add a 6th transaction to the session before ingesting the compression
  - Verify the session is NOT marked as compressed (preserving the extra transaction)

- [ ] 39. Test: storage loads correctly with compressed sessions (filters them out)
  - Create group, compress, store to storage
  - Reload from storage
  - Verify compressed sessions are not included in loaded content messages
  - Verify compression session blob is loaded correctly

- [ ] 40. Test: re-compression consolidates old and new compression sessions
  - First compression: compress sessions S1, S2
  - Add new eligible sessions S3, S4
  - Re-compress: include old compression session + S3, S4
  - Verify single new compression session contains all data
  - Verify old compression session is now compressed itself

- [ ] 41. Test: MAX_DECOMPRESSED_SIZE rejects oversized payloads
  - Craft a compressed blob that exceeds 50MB when decompressed
  - Verify decompression is skipped with error log
  - Verify group remains functional with non-compressed state
