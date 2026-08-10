# Requirements: Group Compression

## Introduction

Groups in Jazz store collaborative permissions, key revelations, and membership changes as CoMap transactions. Each time a member is added to a group, key revelations are created (e.g., `key1_for_account1`) — and these revelations are stored in the session of the admin/manager who performed the invitation. Over time, groups with many members accumulate a large number of sessions, each containing key revelation transactions.

This causes significant load performance issues:

1. **Increased group size**: Large groups require chunking and streaming during sync, increasing network round-trips and latency.
2. **Expensive signature validation**: Each session carries signatures that must be verified during loading. More sessions means more cryptographic operations (Ed25519 verification).
3. **Account dependency explosion**: Each session references an Account (extracted from the SessionID). More sessions means more Account CoValues must be loaded before the group can be fully validated, creating dependency resolution bottlenecks.

Group compression addresses this by allowing an admin to consolidate the net effect of multiple sessions into a single new session, effectively replacing many sessions with one. The compressed sessions can then be pruned, dramatically reducing group size, signature count, and dependency count.

## User Stories & Acceptance Criteria

### US-1: Compress Group Sessions

**As an** admin of a group, **I want** to compress selected sessions into a single session, **so that** the group loads faster and consumes fewer resources.

**Acceptance Criteria:**

- Compression is a manual operation, triggered via the Jazz Inspector UI. It is not automatic.
- Admin users shall see a "Compress Group" button in the inspector when viewing a group.
- The button shall be clickable only once per session (disabled after triggering).
- The button shall be disabled if the group already has a compression session.
- When an admin triggers compression on a group, the system shall compress all eligible sessions.
- The system shall create a new compression session that consolidates the net effect of the selected sessions into a single session.
- The compression transaction shall be trusting (unencrypted), consistent with how all group transactions work.
- The compression session shall use a dedicated session ID format (similar to how delete sessions use `_session_d....$`), so that it is distinguishable from regular sessions.
- The compression transaction metadata shall include the `KnownState` of the sessions being compressed (i.e., `{ [sessionID]: txCount }` for each compressed session). This records exactly which transactions were compressed.
- The compressed transactions in the new session shall preserve their original `madeAt` timestamps, ensuring chronological role resolution in `determineValidTransactionsForGroup` remains correct.
- After compression, peers that receive the compression marker shall be able to prune the compressed sessions from their local state.

### US-1a: Multiple and Concurrent Compressions

**As a** system, **I want** to support multiple compressions over time and concurrent compressions by different admins, **so that** compression remains safe and effective as groups continue to evolve.

**Acceptance Criteria:**

- The system shall allow compression to be performed multiple times on the same group. Each compression targets sessions that have not yet been compressed.
- A compression session itself shall be eligible for compression in a subsequent compression operation (subject to the same eligibility rules).
- When two admins perform compression concurrently, the system shall accept both compression markers. Each compression stores its own `KnownState` snapshot, and their effects shall be independently unpacked and merged.
- The unpacking of concurrent compressions shall be commutative — the final group state shall be the same regardless of the order the compression markers are received.

### US-2: Session Eligibility Rules

**As a** system, **I want** to enforce strict eligibility rules for which sessions can be compressed, **so that** security invariants and dependency discovery are preserved.

**Acceptance Criteria:**

- The system shall only allow accounts with the `admin` role to perform compression.
- Session eligibility is determined by the **current role** of the session owner (the account extracted from the sessionID), checked via the Group API (`group.roleOf()`).
- Sessions owned by accounts with the following roles shall **NOT** be eligible for compression: `admin`, `manager`, `adminInvite`, `managerInvite`, `writerInvite`, `readerInvite`, `writeOnlyInvite`.
- Sessions owned by accounts with the following roles shall be eligible for compression: `reader`, `writer`, `writeOnly`, `revoked`, or accounts no longer in the group.
- The rationale for excluding admin, manager, and invite sessions is to keep dependency discovery simple: those sessions contain role assignments and administrative operations whose authorship is critical for permission validation.
- Verification of a compression transaction shall be deferred until the group is fully downloaded (streaming complete). This is because the full membership state is required to resolve roles of compressed session owners.
- When verifying a compression transaction, the system shall check both that the author is an admin AND that all compressed session owners have eligible roles. If verification fails, the compression shall be invalidated and the compressed sessions restored.

### US-3: Compression Data Integrity

**As a** system, **I want** compression to preserve the semantic meaning of all consolidated transactions, **so that** the group's effective state is unchanged after compression.

**Acceptance Criteria:**

- After compression (and subsequent decompression), the group's resolved state (key revelations, readKey, parent/child extensions, writeKeyFor, groupSealer, profile, root) shall be identical to the state before compression.
- The compression transaction shall pack all changes from compressed sessions into a single transaction. If the packed payload exceeds `MAX_RECOMMENDED_TX_SIZE`, the system shall split across multiple transactions.
- The compressed payload shall store each original change along with its original `madeAt` timestamp and original `sessionID`.
- The compression metadata shall also store the `lastSignature` of each compressed session, enabling post-hoc verification of the compressed data's authenticity.

### US-3a: On-Demand Decompression

**As a** system, **I want** the compressed transactions to be decompressed lazily on demand, **so that** loading a group remains fast when the compressed data is not immediately needed.

**Acceptance Criteria:**

- When a group is loaded, the compression transaction shall NOT be eagerly decompressed. The group operates with only the non-compressed state initially.
- When the group needs data that is not present in the current (non-compressed) state — such as a key revelation or a readKey — the system shall trigger decompression of the compression transaction.
- The decompressed changes shall be loaded into the group state via `processNewTransactions`, making them available for subsequent lookups.
- After decompression, the group's state shall be identical to the state before compression.

### US-4: Handle Late Transactions on Compressed Sessions

**As a** system, **I want** to gracefully handle new transactions arriving on sessions that have already been compressed, **so that** peers with stale state don't cause inconsistencies.

**Acceptance Criteria:**

- When a new transaction arrives on a session that has been marked as compressed, the system shall reject the transaction.
- The system shall emit an appropriate error/warning indicating that the session has been compressed.
- The system shall remain in a consistent state after rejecting a late transaction on a compressed session.

### US-5: Sync Protocol Compatibility

**As a** system, **I want** compression to work correctly across the sync protocol, **so that** all peers eventually converge to a consistent compressed state.

**Acceptance Criteria:**

- When a peer receives a compression marker, the system shall prune the compressed sessions from its local known state.
- The system shall not include compressed sessions in `KnownState` messages after processing a compression marker.
- The system shall propagate compression markers to other connected peers.
- Where a peer has already synced the uncompressed sessions, the system shall transition to the compressed state upon receiving the compression marker.

### US-6: Payload Compression

**As a** system, **I want** the compression session's transaction data to be binary-compressed using a fast algorithm like LZ4, **so that** the wire size and storage footprint of the consolidated session are minimized.

**Acceptance Criteria:**

- The system shall apply a binary compression algorithm (e.g., LZ4) to the transaction payload within the compression session before storing and syncing it.
- The compression format shall be indicated in the transaction metadata so that peers know to decompress before unpacking.
- The decompression step shall be performed transparently when loading/ingesting the compression session — consumers of the group state shall not need to be aware of the binary compression.
- The algorithm choice shall prioritize decompression speed over compression ratio, since decompression happens on every load while compression only happens once.

### US-7: Storage Behavior

**As a** system, **I want** compressed sessions to be excluded from sync without requiring active storage cleanup, **so that** implementation is simple and non-destructive.

**Acceptance Criteria:**

- After compression, the system shall stop including compressed sessions in sync messages.
- The system shall not actively delete compressed session data from storage — compressed sessions are simply excluded from sync and from the group's active known state.
- Storage adapters are not required to reclaim disk space for compressed sessions. Lazy cleanup may be implemented in the future as an optimization.
