# Design: Group Compression

## Overview

Group compression consolidates transactions from multiple sessions in a group into a single compression session, reducing session count, signature validation overhead, and account dependency bloat. The mechanism follows the same pattern as the existing delete operation: a special session type with metadata that triggers state changes during ingestion.

The core idea is that eligible sessions (owned by non-admin, non-manager, non-invite members) are packed into a single LZ4-compressed transaction on a new compression session. The original sessions are then pruned from `KnownState` and sync. Decompression is **lazy** — the compressed blob is only unpacked when the group needs data not present in its non-compressed state (e.g., looking up a key revelation). When decompression is triggered, the entries are loaded into the group state via `processNewTransactions`.

**Rust-first implementation**: LZ4 compression/decompression and the KnownState computation for compressed sessions are implemented in the Rust `cojson-core` crate and exposed through the WASM, NAPI, and React Native bindings. This ensures consistent behavior across all platforms and avoids JavaScript LZ4 library dependencies.

## Architecture / Components

### 1. Compression Session ID Format

Following the delete session pattern (`_session_d....$`), compression sessions use a distinct suffix:

```typescript
// In ids.ts
export type CompressionSessionID = `${RawAccountID | AgentID}_session_z${string}@`;

const CHAR_AT = "@".charCodeAt(0);

export function isCompressionSessionID(
  sessionID: SessionID,
): sessionID is CompressionSessionID {
  return sessionID.charCodeAt(sessionID.length - 1) === CHAR_AT;
}
```

```typescript
// In crypto.ts — CryptoProvider
newCompressionSessionID(accountID: RawAccountID | AgentID): CompressionSessionID {
  const randomPart = base58.encode(this.randomBytes(7));
  return `${accountID}_session_z${randomPart}@`;
}
```

| Type | Format | Suffix | Example |
|------|--------|--------|---------|
| Active | `{account}_session_z{random}` | (none) | `co_z123_session_zABC` |
| Delete | `{account}_session_d{random}$` | `$` | `co_z123_session_dABC$` |
| Compression | `{account}_session_z{random}@` | `@` | `co_z123_session_zABC@` |

### 2. Compression Transaction Structure

A compression creates a single trusting transaction (or multiple if exceeding `MAX_RECOMMENDED_TX_SIZE`) on a new compression session. The first transaction carries the metadata:

```typescript
interface CompressionMeta {
  compressed: {
    // KnownState snapshot: which sessions and how many transactions were compressed
    sessions: { [sessionID: SessionID]: number };
    encoding: "lz4";
  };
}
```

The compression timestamp is the transaction's own `madeAt` field — no need to duplicate it in the meta.

The `changes` field of the transaction contains the LZ4-compressed payload — a single base64-encoded string that, when decompressed, yields an array of `CompressedSession` objects, one per original session:

```typescript
interface CompressedSession {
  sessionID: SessionID;
  lastSignature: Signature;
  transactions: CompressedTx[];
}

interface CompressedTx {
  madeAt: number;         // Original timestamp
  changes: JsonValue[];   // The MapOp changes from this transaction
  meta?: JsonValue;       // Optional transaction meta
}
```

The full payload structure:

```
Transaction.changes = [base64(lz4(JSON.stringify(CompressedSession[])))]
```

This structure mirrors the original session layout — each `CompressedSession` corresponds to an original session with its signature and ordered list of transactions. The `lastSignature` is stored for informational purposes and potential future verification, but is **not verified on decompression**.

**Security model — trust-the-admin**: The compressed payload is trusted without cryptographic verification of its contents. Since only admins can create compression transactions (enforced in `tryAddTransactions`), and admins already have full control over the group (they can assign roles, rotate keys, etc.), trusting their compressed payloads does not expand the threat surface. An admin who wanted to inject fake key revelations or tamper with data could already do so through normal group operations.

**Why a single string**: LZ4 compression benefits from a large contiguous input. Key revelation values have high repetition in their prefixes (`key_z...`, `sealed_z...`), so compressing them together yields significant reduction. Splitting into individual transactions would lose this benefit. Grouping by session also improves compression ratio since adjacent transactions within a session tend to share similar key patterns.

**Size splitting**: The base64-encoded LZ4 string is split by character offset across multiple transactions if it exceeds `MAX_RECOMMENDED_TX_SIZE` (100KB). Only the first transaction carries the `CompressionMeta`. Subsequent transactions carry plain string chunks with no special meta. On decompression, the receiver concatenates the string from all transactions in the compression session before decoding.

### 3. Session Eligibility Detection

Eligibility is determined by the **current role** of the session owner (account or agent), checked via the Group API. This avoids parsing transaction content:

```typescript
// In group.ts
function isSessionEligibleForCompression(
  group: RawGroup,
  sessionID: SessionID,
): boolean {
  const accountOrAgent = accountOrAgentIDfromSessionID(sessionID);

  // Check role for both accounts and agents — agent sessions often belong
  // to invite-performing agents, so we must verify their role in the group
  const role = group.roleOf(accountOrAgent);

  // NOT eligible: admin, manager, and all invite roles
  if (
    role === "admin" ||
    role === "manager" ||
    role === "adminInvite" ||
    role === "managerInvite" ||
    role === "writerInvite" ||
    role === "readerInvite" ||
    role === "writeOnlyInvite"
  ) {
    return false;
  }

  // Eligible: reader, writer, writeOnly, revoked, undefined (not in group)
  return true;
}

function getEligibleSessionsForCompression(group: RawGroup): SessionID[] {
  const eligible: SessionID[] = [];
  for (const [sessionID] of group.core.verified.sessionEntries()) {
    if (isCompressionSessionID(sessionID)) continue; // Skip existing compression sessions
    if (isDeleteSessionID(sessionID)) continue;       // Skip delete sessions
    if (isSessionEligibleForCompression(group, sessionID)) {
      eligible.push(sessionID);
    }
  }
  return eligible;
}
```

**Rationale**: Admin and manager sessions contain role assignments and administrative operations. Their authorship is critical for `determineValidTransactionsForGroup`, which checks the transactor's role at transaction time. Invite sessions perform the initial role assignment. Agent sessions are also checked because agents often perform invite operations. By excluding sessions with admin, manager, or invite roles, we ensure compressed sessions only contain data (key revelations, writeKeyFor, etc.) where authorship doesn't affect permission validation.

### 4. Compression Execution Flow

```typescript
// In coValueCore.ts
validateCompressionPermissions(): { ok: true } | { ok: false; reason: string; message: string } {
  if (!this.verified) {
    return { ok: false, reason: "CannotVerifyPermissions", message: "..." };
  }
  if (!this.isGroup()) {
    return { ok: false, reason: "NotAGroup", message: "Only groups can be compressed" };
  }
  const group = expectGroup(this.getCurrentContent());
  if (group.myRole() !== "admin") {
    return { ok: false, reason: "NotAdmin", message: "Only admins can compress groups" };
  }
  return { ok: true };
}

compressGroup(sessionIDs: SessionID[]): boolean {
  const result = this.validateCompressionPermissions();
  if (!result.ok) {
    throw new Error(result.message);
  }

  const group = expectGroup(this.getCurrentContent());

  // 1. Collect eligible sessions and build compressed payload
  const sessionsKnownState: CompressionMeta["compressed"]["sessions"] = {};
  const compressedSessions: CompressedSession[] = [];

  for (const sessionID of sessionIDs) {
    if (!isSessionEligibleForCompression(group, sessionID)) {
      continue; // Skip ineligible
    }

    const sessionLog = this.verified.getSessionLog(sessionID);
    if (!sessionLog || sessionLog.transactions.length === 0) continue;

    sessionsKnownState[sessionID] = sessionLog.transactions.length;

    const compressedTxs: CompressedTx[] = [];
    for (const tx of sessionLog.transactions) {
      const changes = parseJSON(tx.changes);
      const meta = tx.meta ? parseJSON(tx.meta) : undefined;
      compressedTxs.push({ madeAt: tx.madeAt, changes, meta });
    }

    compressedSessions.push({
      sessionID,
      lastSignature: sessionLog.lastSignature,
      transactions: compressedTxs,
    });
  }

  if (compressedSessions.length === 0) {
    return false;
  }

  // 2. LZ4-compress the sessions (lz4 runs in the Rust cojson-core crate,
  //    exposed via WASM/NAPI/RN bindings)
  const jsonPayload = JSON.stringify(compressedSessions);
  const compressed = this.crypto.lz4Compress(new TextEncoder().encode(jsonPayload));
  const encodedPayload = base64Encode(compressed);

  // 3. Create compression transaction(s)
  const compressionSessionID = this.crypto.newCompressionSessionID(
    this.node.getCurrentAccountOrAgentID(),
  );

  const now = Date.now();
  const meta: CompressionMeta = {
    compressed: {
      sessions: sessionsKnownState,
      encoding: "lz4",
    },
  };

  // Split the encoded string across transactions if it exceeds MAX_RECOMMENDED_TX_SIZE
  const maxSize = TRANSACTION_CONFIG.MAX_RECOMMENDED_TX_SIZE;
  const chunks = splitString(encodedPayload, maxSize);

  for (let i = 0; i < chunks.length; i++) {
    this.makeCompressionTransaction(
      compressionSessionID,
      [chunks[i]],              // Single string chunk per transaction
      i === 0 ? meta : undefined, // Only first transaction carries meta
      now,
    );
  }

  // 4. Mark compressed sessions for pruning
  this.markSessionsAsCompressed(sessionsKnownState);

  return true;
}
```

### 5. Compression Transaction Ingestion

During `tryAddTransactions`, compression sessions are detected and validated:

Compression transaction validation is performed **before** adding the session to the Rust `SessionMapImpl`. If the group is still streaming, the compression transaction is **parked** until streaming completes. Compressed sessions are excluded from the streaming check so they don't block completion.

#### Phase 1: Detect and park (during `tryAddTransactions`)

When a compression session is detected, we check if the group is still streaming, **excluding compression sessions (those ending with `@`) from the streaming check**. This ensures we wait for all "real" session data to arrive before processing any compression transactions, but don't wait for other compression sessions which are independent and can be processed separately. If streaming is still in progress for non-compression sessions, the compression transaction is parked — queued for processing once streaming completes.

```typescript
// In coValueCore.ts — alongside #isDeleteTransaction
#isCompressionTransaction(
  sessionID: SessionID,
  newTransactions: Transaction[],
  skipVerify: boolean,
): { value: boolean; parked?: boolean; err?: CompressionTransactionRejectedError } {
  if (!isCompressionSessionID(sessionID)) {
    return { value: false };
  }

  if (!this.isGroup()) {
    return {
      value: true,
      err: {
        type: "CompressionTransactionRejected",
        reason: "NotAGroup",
        id: this.id,
        sessionID,
        error: new Error("Compression is only valid on groups"),
      },
    };
  }

  // Exclude compression sessions (@-suffix) from the streaming check —
  // we only need all non-compression session data before validating.
  if (this.isStreaming({ excludeCompressionSessions: true })) {
    this.parkCompressionTransaction(sessionID, newTransactions, compressionMeta);
    return { value: true, parked: true };
  }

  return { value: true };
}
```

When the compression is parked, the transaction is not yet added to the `SessionMapImpl`. Once streaming completes (i.e., `isStreaming({ excludeCompressionSessions: true })` returns `false` — meaning all non-`@`-suffix sessions have arrived), parked compression transactions are dequeued and validated.

#### Phase 2: Validate and accept (after streaming completes)

Once streaming is complete and the full membership state is available, parked compression transactions are validated. This validation is performed in `tryAddTransactions` (in `coValueCore.ts`), **not** in `determineValidTransactionsForGroup`. This is intentional: the sync server runs `tryAddTransactions` but does not run `determineValidTransactionsForGroup`, so the validation must happen there to be enforced server-side.

1. **Author is admin at compression time**: The compression session owner must have `admin` role at the time of the compression transaction (`madeAt` from the transaction itself). This uses a role-at-time lookup (`roleOfAt`) to avoid race conditions where a role change arrives in a different order on different peers.
2. **No duplicate sessions**: The `compressed.sessions` map must not contain duplicate session IDs.
3. **Compressed session owners are eligible at compression time**: For each session listed in `compressed.sessions`, the session owner's role at the transaction's `madeAt` time must NOT be `admin`, `manager`, or any invite role. This also uses `roleOfAt` to ensure deterministic validation regardless of transaction arrival order.

If validation passes, the compression transaction is added to the `SessionMapImpl` and the compressed sessions are marked for pruning.

```typescript
// In coValueCore.ts — within tryAddTransactions, after streaming completes
// and parked compression transactions are dequeued
#validateCompressionTransaction(
  sessionID: CompressionSessionID,
  madeAt: number,
  compressionMeta: CompressionMeta,
): { valid: boolean; error?: string } {
  const group = this.getGroup();
  if (!group) return { valid: false, error: "Not a group" };

  // 1. Author must be admin at the time of the compression transaction
  const authorAccountID = accountOrAgentIDfromSessionID(sessionID);
  const authorRole = group.roleOfAt(authorAccountID, madeAt);
  if (authorRole !== "admin") {
    return { valid: false, error: "Only admins can create compression transactions" };
  }

  // 2. Check for duplicate sessions in compression meta
  const compressedSessionIDs = Object.keys(compressionMeta.compressed.sessions);
  const uniqueSessionIDs = new Set(compressedSessionIDs);
  if (uniqueSessionIDs.size !== compressedSessionIDs.length) {
    return { valid: false, error: "Duplicate session in compression meta" };
  }

  // 3. Validate compressed session owners are eligible (role at compression time)
  // Both accounts and agents are checked — agents can hold invite roles
  for (const compressedSessionID of compressedSessionIDs) {
    const sessionOwner = accountOrAgentIDfromSessionID(compressedSessionID as SessionID);
    const ownerRole = group.roleOfAt(sessionOwner, madeAt);
    if (
      ownerRole === "admin" ||
      ownerRole === "manager" ||
      ownerRole === "adminInvite" ||
      ownerRole === "managerInvite" ||
      ownerRole === "writerInvite" ||
      ownerRole === "readerInvite" ||
      ownerRole === "writeOnlyInvite"
    ) {
      return {
        valid: false,
        error: "Compression includes sessions from admin/manager/invite members",
      };
    }
  }

  return { valid: true };
}
```

After validation, the compressed sessions are marked for pruning:

```typescript
// In tryAddTransactions, after validation succeeds
const validation = this.#validateCompressionTransaction(sessionID, compressionMeta);
if (!validation.valid) {
  // Reject the compression transaction — do not add to SessionMapImpl
  return { errors: [validation.error] };
}

this.markSessionsAsCompressed(compressionMeta.compressed.sessions);
```

#### Permissions: `determineValidTransactionsForGroup`

In `determineValidTransactionsForGroup` (in `permissions.ts`), compression sessions are **always considered valid**. No additional checks are performed there — the validation is fully handled by `tryAddTransactions` as described above.

```typescript
// In permissions.ts — within determineValidTransactionsForGroup
if (isCompressionSessionID(transaction.txID.sessionID)) {
  transaction.markValid();
  continue;
}
```

**Intentional: compression survives author demotion.** Because `determineValidTransactionsForGroup` unconditionally marks compression sessions as valid, a compression is never re-evaluated if the author is later demoted or revoked. This is by design — compression is a one-way, irreversible consolidation operation. The validation at ingestion time (in `tryAddTransactions`) ensures the author was an admin when the compression was created; subsequent role changes do not retroactively invalidate it. This mirrors the trust model for other admin operations like role assignments, which also remain valid after the assigning admin is demoted.

#### Streaming state management

The `isStreaming` method on `CoValueCore` accepts an option to exclude **compression sessions** (those ending with `@`) from the check. This is distinct from "compressed sessions" (the original sessions whose data was packed into a blob):

```typescript
// In coValueCore.ts
isStreaming(options?: { excludeCompressionSessions: boolean }) {
  if (!this.verified) return false;

  if (options?.excludeCompressionSessions) {
    // Exclude all compression sessions (@-suffix) from the streaming check.
    // We only need all non-compression session data to arrive before
    // processing parked compression transactions.
    return this.verified.isStreaming({ excludeCompressionSessions: true });
  }

  return this.verified.isStreaming();
}
```

```typescript
// In verifiedState.ts
isStreaming(options?: { excludeCompressionSessions: boolean }): boolean {
  const streamingState = this.impl.getKnownStateWithStreaming();
  if (!streamingState) return false;

  if (options?.excludeCompressionSessions) {
    // Check if any non-compression sessions are still pending
    const sessions = (streamingState as CoValueKnownState).sessions;
    const knownSessions = this.knownState().sessions;
    for (const [sessionID, expectedCount] of Object.entries(sessions)) {
      if (isCompressionSessionID(sessionID as SessionID)) continue;
      const currentCount = knownSessions[sessionID as SessionID] ?? 0;
      if (currentCount < expectedCount) return true;
    }
    return false;
  }

  return true;
}
```

This ensures the streaming check returns `false` once all non-compression sessions have arrived, even if the original `expectContentUntil` included compression sessions that haven't arrived yet.

**What if validation fails?** If the compression transaction is marked invalid, the sessions it referenced are restored — they're removed from the `compressedSessions` map and become active again.

### 6. Session Pruning and KnownState

Compressed sessions are tracked in the **Rust `SessionMapImpl`**, not in TypeScript. This ensures that `knownState()` is computed entirely on the Rust side with compressed session counts already merged in:

```rust
// In cojson-core (Rust) — SessionMapImpl gains:
struct SessionMapImpl {
    // ... existing session data ...

    // Maps compressed sessionID -> txCount at time of compression
    compressed_sessions: HashMap<SessionID, u64>,
}

impl SessionMapImpl {
    fn mark_sessions_as_compressed(&mut self, sessions: HashMap<SessionID, u64>) {
        for (session_id, tx_count) in sessions {
            // Only mark as compressed if the session doesn't have more transactions
            // than what was captured in the compression. This prevents data loss
            // when a session receives late transactions between compression creation
            // and ingestion.
            let current_tx_count = self.get_transactions_count(&session_id).unwrap_or(0);
            if current_tx_count > tx_count {
                continue;
            }

            let existing = self.compressed_sessions.get(&session_id).copied().unwrap_or(0);
            // Take the max txCount to handle concurrent compressions
            self.compressed_sessions.insert(session_id, existing.max(tx_count));
        }
    }

    fn is_session_compressed(&self, session_id: &SessionID) -> bool {
        self.compressed_sessions.contains_key(session_id)
    }
}
```

The TypeScript `VerifiedState` delegates to the Rust implementation:

```typescript
// In verifiedState.ts
markSessionsAsCompressed(
  sessions: CompressionMeta["compressed"]["sessions"],
) {
  this.impl.markSessionsAsCompressed(sessions);
  this.invalidateCache();
}

isSessionCompressed(sessionID: SessionID): boolean {
  return this.impl.isSessionCompressed(sessionID);
}
```

**KnownState** is computed entirely on the Rust side — the Rust `SessionMapImpl.getKnownState()` already includes compressed session counts merged in. No TypeScript-side merging is needed:

```typescript
// knownState() — Rust side already includes compressed sessions
knownState(): CoValueKnownState {
  return this.impl.getKnownState() as CoValueKnownState;
}
```

```rust
// In cojson-core (Rust) — getKnownState includes compressed sessions
fn get_known_state(&self) -> CoValueKnownState {
    let mut sessions = self.get_active_session_counts();

    // Merge in compressed session tx counts
    for (session_id, tx_count) in &self.compressed_sessions {
        let existing = sessions.get(session_id).copied().unwrap_or(0);
        sessions.insert(session_id.clone(), existing.max(*tx_count));
    }

    CoValueKnownState { header: true, sessions }
}
```

**getSessions and newContentSince** exclude compressed sessions — we claim to know them but don't send their transactions (the data lives in the compression blob instead):

```typescript
// getSessions() — excludes compressed sessions from iteration
getSessions(): Map<SessionID, SessionLog> {
  const map = new Map<SessionID, SessionLog>();
  const sessionIds = this.impl.getSessionIds() as SessionID[];
  for (const sessionID of sessionIds) {
    if (this.isSessionCompressed(sessionID)) continue;
    map.set(sessionID, this.getSessionLog(sessionID));
  }
  return map;
}
```

### 6a. Compressed Sessions at Sync and Storage Layers

The key principle is: **KnownState includes compressed sessions** (so peers know we already have them), but **content messages exclude them** (their data is in the compression blob).

#### Sync Layer — Sending Content to Peers

`newContentSince()` iterates sessions via `getSessions()`, which excludes compressed sessions. So compressed session transactions are never sent — only the compression session (with its blob) is sent.

`knownState()` includes compressed sessions with their tx counts (merged from the compression meta). This means peers see that we "know" those sessions and won't try to send them to us.

```typescript
// handleKnownState in sync.ts — no changes needed
// coValue.knownState() includes compressed sessions (peer won't re-send)
// newContentSince() uses getSessions() which excludes them (we don't send their data)
```

**Correction flow**: If a peer sends a `KnownState` correction that references a compressed session, `newContentSince()` won't include that session's transactions in the response. The peer will see from our next KnownState that we claim to have those transactions, and will stop requesting them.

#### Sync Layer — Receiving Content from Peers

When a peer sends a `NewContentMessage` that includes transactions for a compressed session, `tryAddTransactions` rejects it with `CompressedSessionRejected`:

```typescript
// In handleNewContent (sync.ts), the session loop:
for (const [sessionID, newContentForSession] of getSessionEntriesFromContentMessage(msg)) {
  // ...
  const error = coValue.tryAddTransactions(sessionID, ...);
  // If session is compressed, error = { type: "CompressedSessionRejected" }
  // The error is logged and the session is skipped — no crash, no inconsistency
}
```

The local node responds with its KnownState (which includes the compressed sessions), telling the peer "I already know about those sessions" — the peer converges and stops syncing them.

#### Storage Layer — Loading from Storage

Storage filters out compressed sessions at load time. When loading a CoValue, the storage layer first scans for compression sessions. For each compression session found, it extracts the `compressed.sessions` meta to build the set of compressed session IDs. Those sessions are then skipped when constructing `NewContentMessage` chunks.

This is safe because a compression session only reaches storage after it has been validated. If it's in the database, the compressed sessions' data is already captured in the compression blob — no need to load them.

```typescript
// In storageAsync.ts / storageSync.ts — loadCoValue()
// 1. Scan allCoValueSessions for compression sessions (isCompressionSessionID)
// 2. For each compression session, read its first transaction's meta
//    to extract compressed.sessions
// 3. Build a Set<SessionID> of compressed sessions
// 4. Skip those sessions when iterating allCoValueSessions to build content messages
```

#### Storage Layer — Storing Content

`storeContent()` stores the `validNewContent` message, built from successfully ingested sessions. Since compressed sessions are rejected by `tryAddTransactions`, they're never re-stored when received from peers.

The compression transaction itself is stored as a normal session — storage doesn't need to know about compression.

#### Storage KnownState

`StorageKnownState` caches known state from the database. It includes compressed sessions in the counts (they're still rows in the sessions table), which is consistent with the in-memory `knownState()` that also includes them via the Rust `SessionMapImpl`'s compressed session merge. Both layers agree on what sessions exist and their tx counts.

### 7. On-Demand Decompression

This is the key performance optimization. The compressed blob is NOT eagerly unpacked. Instead, it is decompressed lazily when the group needs missing data.

#### 7.1 Storage in RawGroup

```typescript
// In group.ts — RawGroup gains:
class RawGroup {
  // Pending compressed blobs that haven't been decompressed yet
  private pendingCompressedBlobs: {
    payload: string;              // base64(lz4(...)) encoded payload
    compressionSessionID: SessionID;
  }[] = [];

  // Whether decompression has been performed
  private isDecompressed: boolean = false;
}
```

When `processNewTransactions` encounters a compression transaction, it stores the blob instead of processing it:

```typescript
// In group.ts — override handleNewTransaction
override handleNewTransaction(transaction: DecryptedTransaction): void {
  // Check if this is a compression transaction (from a compression session)
  if (isCompressionSessionID(transaction.txID.sessionID)) {
    // Accumulate string chunks from compression transactions
    // The first transaction has the meta; subsequent ones are plain string chunks
    const chunk = transaction.changes[0] as string;
    if (typeof chunk === "string") {
      const sessionID = transaction.txID.sessionID;
      let blob = this.pendingCompressedBlobs.find(
        (b) => b.compressionSessionID === sessionID,
      );
      if (!blob) {
        blob = { payload: "", compressionSessionID: sessionID };
        this.pendingCompressedBlobs.push(blob);
      }
      blob.payload += chunk; // Concatenate chunks in order
      return; // Don't process as regular transaction
    }
  }

  // Regular transaction handling (parent group cache, key revelations cache)
  super.handleNewTransaction(transaction);
}
```

#### 7.2 Triggering Decompression

Decompression is triggered from key lookup methods when they can't find what they need:

```typescript
// In group.ts — added to key lookup methods
private decompressIfNeeded(): void {
  if (this.isDecompressed || this.pendingCompressedBlobs.length === 0) {
    return;
  }

  this.isDecompressed = true;

  // Decompress all pending blobs
  for (const blob of this.pendingCompressedBlobs) {
    const compressed = base64Decode(blob.payload);
    const result = this.crypto.lz4Decompress(compressed); // lz4Decompress should automatically fail if the compressed size is bigger than 250MB

    if (!result.ok) return;

    const json = new TextDecoder().decode(result.data);
    const sessions: CompressedSession[] = JSON.parse(json);

    // Process each session's transactions (behaves like merged transactions —
    // original session IDs and sequential indices are preserved)
    for (const session of sessions) {
      this.processDecompressedTransactions(session);
    }
  }

  this.pendingCompressedBlobs = [];
}

private processDecompressedTransactions(
  session: CompressedSession,
): void {
  // Decompressed entries behave like merged transactions: they use
  // the original session ID and sequential tx/change indices, preserving
  // authorship and ensuring unique txIDs for correct ordering.
  for (let txIndex = 0; txIndex < session.transactions.length; txIndex++) {
    const tx = session.transactions[txIndex]!;
    for (let changeIdx = 0; changeIdx < tx.changes.length; changeIdx++) {
      const change = tx.changes[changeIdx] as { op: "set" | "del"; key: string; value?: any };

      const mapOp = {
        txID: { sessionID: session.sessionID, txIndex },
        madeAt: tx.madeAt,
        changeIdx,
        change,
        trusting: true,
      };

      const key = change.key as keyof GroupShape & string;
      const entries = this.ops[key];
      if (!entries) {
        this.ops[key] = [mapOp];
      } else {
        entries.push(mapOp);
        entries.sort(this.core.compareTransactions);
      }
      this.latest[key] = this.ops[key]![this.ops[key]!.length - 1];

      // Update caches (parent groups, key revelations)
      if (isParentGroupReference(change.key)) {
        this.updateParentGroupCache(change.key, change.value, tx.madeAt);
      } else if (isKeyForKeyField(change.key)) {
        this.updateKeyRevelationsCache(change.key);
      }
    }
  }
}
```

#### 7.3 Integration Points

Decompression is triggered from the methods that look up data that might be in compressed blobs:

```typescript
// In group.ts — key lookup methods call decompressIfNeeded()

getReadKey(keyID: KeyID): KeySecret | undefined {
  // First try without decompression
  const result = this.getReadKeyFromCurrentState(keyID);
  if (result) return result;

  // Trigger decompression and retry
  this.decompressIfNeeded();
  return this.getReadKeyFromCurrentState(keyID);
}

// Similarly for:
// - findKeyRevelation methods
// - getParentGroups (if parent extension is in compressed data)
// - Any other method that looks up group entries
```

### 8. Handling Late Transactions on Compressed Sessions

```typescript
// In coValueCore.ts — early in tryAddTransactions
if (this.verified.isSessionCompressed(sessionID)) {
  return {
    type: "CompressedSessionRejected",
    id: this.id,
    sessionID,
    error: new Error(
      `Session ${sessionID} has been compressed and cannot accept new transactions`,
    ),
  } as const;
}
```

### 9. Concurrent Compressions

When two admins compress concurrently:

1. Admin A compresses sessions S1, S2, S3 → creates compression session CA
2. Admin B compresses sessions S2, S3, S4 → creates compression session CB

When a peer receives both:
- Both CA and CB are accepted (different compression sessions)
- `compressedSessions` map merges both, using `Math.max(txCount)` for overlapping sessions (S2, S3)
- All four sessions (S1–S4) are pruned from active known state
- Both compressed blobs are stored as `pendingCompressedBlobs`
- On decompression, sessions from both blobs are unpacked; overlapping sessions (S2, S3) produce duplicate MapOps, resolved by CoMap last-writer-wins ordering

Re-compression later can consolidate CA + CB into a single session (see section 9a).

### 9a. Re-Compressing a Compressed Session

A compression session is itself eligible for compression (it's not owned by an admin/manager/invite — it's a special session type). This enables iterative compression: as a group grows, new compressions can consolidate older compression sessions alongside newly-eligible regular sessions.

The re-compression flow:

1. **Decompress the old blob**: Extract the `CompressedSession[]` from the existing compression transaction's LZ4 payload.

2. **Filter out stale sessions**: Compare each `CompressedSession` in the old blob against the current `VerifiedState`. If the current state has a session with **more transactions** than what was captured in the old blob (i.e., `currentTxCount > compressedSession.transactions.length`), discard that session from the old blob — the current state has fresher data. This handles the case where a compressed session received additional transactions between the old compression and now.

3. **Merge with new sessions**: Collect all the `CompressedSession` entries that survived filtering, then add the new eligible sessions being compressed in this round.

4. **Apply compression**: Pack the merged set into a new LZ4-compressed payload and create a new compression transaction.

```typescript
recompressGroup(sessionIDs: SessionID[]): boolean {
  const result = this.validateCompressionPermissions();
  if (!result.ok) {
    throw new Error(result.message);
  }

  const group = expectGroup(this.getCurrentContent()) as RawGroup;

  const sessionsKnownState: CompressionMeta["compressed"]["sessions"] = {};
  const allCompressedSessions: CompressedSession[] = [];

  for (const sessionID of sessionIDs) {
    // Case 1: This is an existing compression session — decompress and merge
    if (isCompressionSessionID(sessionID)) {
      const sessionLog = this.verified.getSessionLog(sessionID);
      if (!sessionLog) continue;

      // Extract the LZ4 blob from the compression transaction
      const blob = extractCompressionBlob(sessionLog);
      if (!blob) continue;

      const oldSessions: CompressedSession[] = decompressPayload(blob);

      // Filter: keep only sessions whose tx count matches or exceeds
      // what we have in the current verified state
      for (const oldSession of oldSessions) {
        const currentTxCount =
          this.verified.getTransactionsCount(oldSession.sessionID) ?? 0;

        if (currentTxCount > oldSession.transactions.length) {
          // Current state has more transactions than the old blob captured —
          // skip this session, it will be re-collected from the live state
          // if it's still eligible
          continue;
        }

        allCompressedSessions.push(oldSession);
        sessionsKnownState[oldSession.sessionID] = oldSession.transactions.length;
      }

      // Also mark the old compression session itself as compressed
      sessionsKnownState[sessionID] = sessionLog.transactions.length;
      continue;
    }

    // Case 2: Regular session — collect as before
    if (!isSessionEligibleForCompression(group, sessionID)) {
      continue;
    }

    const sessionLog = this.verified.getSessionLog(sessionID);
    if (!sessionLog || sessionLog.transactions.length === 0) continue;

    sessionsKnownState[sessionID] = sessionLog.transactions.length;

    const compressedTxs: CompressedTx[] = [];
    for (const tx of sessionLog.transactions) {
      const changes = parseJSON(tx.changes);
      const meta = tx.meta ? parseJSON(tx.meta) : undefined;
      compressedTxs.push({ madeAt: tx.madeAt, changes, meta });
    }

    allCompressedSessions.push({
      sessionID,
      lastSignature: sessionLog.lastSignature,
      transactions: compressedTxs,
    });
  }

  if (allCompressedSessions.length === 0) {
    return false;
  }

  // Create new compression transaction with merged payload
  const jsonPayload = JSON.stringify(allCompressedSessions);
  const compressed = this.crypto.lz4Compress(new TextEncoder().encode(jsonPayload));
  const encodedPayload = base64Encode(compressed);

  const compressionSessionID = this.crypto.newCompressionSessionID(
    this.node.getCurrentAccountOrAgentID(),
  );

  const meta: CompressionMeta = {
    compressed: {
      sessions: sessionsKnownState,
      encoding: "lz4",
    },
  };

  const maxSize = TRANSACTION_CONFIG.MAX_RECOMMENDED_TX_SIZE;
  const chunks = splitString(encodedPayload, maxSize);

  for (let i = 0; i < chunks.length; i++) {
    this.makeCompressionTransaction(
      compressionSessionID,
      [chunks[i]],
      i === 0 ? meta : undefined,
      Date.now(),
    );
  }

  this.markSessionsAsCompressed(sessionsKnownState);
  return true;
}
```

**Key invariant**: The stale-session filter (step 2) ensures that if a session received additional transactions after the old compression, those transactions are not lost. They either:
- Come from the live `VerifiedState` (if the session is still in the session map), or
- Were already captured in a newer compression

The `compressGroup` method can be updated to also handle compression sessions in its input, or `recompressGroup` can be the single entry point that handles both cases uniformly.

### 10. Inspector UI

Compression is a manual operation exposed through the Jazz Inspector. It is not triggered automatically.

#### Button State

The Inspector's group detail view shows a "Compress Group" button with the following states:

- **Visible**: Only when the current user has `admin` role on the group AND the group has more than 2,000 transactions.
- **Enabled**: When the group has no existing compression sessions (i.e., no `CompressionSessionID` sessions in the session list).
- **Disabled (already compressed)**: When the group already has at least one compression session. The button shows a tooltip like "Group already compressed."
- **Disabled (already clicked)**: After the button is clicked once in the current session, it is disabled to prevent double-compression. The button shows "Compressing..." or "Compressed" as feedback.

#### Trigger Flow

When the admin clicks "Compress Group":

1. The inspector calls `getEligibleSessionsForCompression(group)` to find all eligible sessions.
2. If no eligible sessions are found, a message is shown: "No eligible sessions to compress."
3. Otherwise, `group.core.compressGroup(eligibleSessions)` is called.
4. The button is permanently disabled for the rest of the inspector session.

```typescript
// Inspector component (simplified)
function CompressGroupButton({ group }: { group: RawGroup }) {
  const [compressed, setCompressed] = useState(false);

  const isAdmin = group.myRole() === "admin";
  const hasExistingCompression = hasCompressionSession(group);
  const totalTxCount = getTotalTransactionCount(group);
  const visible = isAdmin && totalTxCount > 2000;
  const disabled = hasExistingCompression || compressed;

  if (!visible) return null;

  const handleCompress = () => {
    const eligible = getEligibleSessionsForCompression(group);
    if (eligible.length === 0) return;

    group.core.compressGroup(eligible);
    setCompressed(true);
  };

  return (
    <button disabled={disabled} onClick={handleCompress}>
      {compressed ? "Compressed" : hasExistingCompression ? "Already compressed" : "Compress Group"}
    </button>
  );
}

function hasCompressionSession(group: RawGroup): boolean {
  for (const [sessionID] of group.core.verified.sessionEntries()) {
    if (isCompressionSessionID(sessionID)) return true;
  }
  return false;
}
```

### 11. Dependency Impact

After compression, the dependency graph is reduced:

- **Before**: Group depends on Account A (admin), B (writer), C (reader), D (writer), E (reader)
- **After**: If sessions from B, C, D, E were compressed by admin A, the group now only depends on A

The `getDependenciesFromSessions` function naturally reflects this because compressed sessions are excluded from `getSessions()` / `sessionEntries()`. The compression session is owned by admin A, who was already a dependency.

## Data Models

### New Types

```typescript
// ids.ts
export type CompressionSessionID = `${RawAccountID | AgentID}_session_z${string}@`;

// Compression metadata in transaction
interface CompressionMeta {
  compressed: {
    sessions: { [sessionID: SessionID]: number }; // KnownState: sessionID -> txCount
    encoding: "lz4";
  };
}
// Note: compression timestamp comes from the transaction's own madeAt field

// Compressed payload structure (inside the LZ4 blob)
interface CompressedSession {
  sessionID: SessionID;
  lastSignature: Signature;
  transactions: CompressedTx[];
}

interface CompressedTx {
  madeAt: number;
  changes: JsonValue[];
  meta?: JsonValue;
}

// Error types
type CompressionTransactionRejectedError = {
  type: "CompressionTransactionRejected";
  id: RawCoID;
  sessionID: SessionID;
  reason: "NotAGroup" | "NotAdmin" | "InvalidMeta";
  error: Error;
};

type CompressedSessionRejectedError = {
  type: "CompressedSessionRejected";
  id: RawCoID;
  sessionID: SessionID;
  error: Error;
};
```

### Modified Types

```rust
// cojson-core (Rust) — SessionMapImpl gains:
compressed_sessions: HashMap<SessionID, u64>;
fn mark_sessions_as_compressed(&mut self, sessions: HashMap<SessionID, u64>);
fn is_session_compressed(&self, session_id: &SessionID) -> bool;
// getKnownState() now merges compressed session counts automatically
// lz4_compress(data: &[u8]) -> Vec<u8>
// lz4_decompress(data: &[u8]) -> Result<Vec<u8>, Error>
```

```typescript
// verifiedState.ts — VerifiedState delegates to Rust:
markSessionsAsCompressed(sessions: CompressionMeta["compressed"]["sessions"]): void;
isSessionCompressed(sessionID: SessionID): boolean;

// coValueCore.ts — CoValueCore gains:
compressGroup(sessionIDs: SessionID[]): boolean;
validateCompressionPermissions(): { ok: true } | { ok: false; reason: string; message: string };

// group.ts — RawGroup gains:
private pendingCompressedBlobs: { payload: string; compressionSessionID: SessionID }[];
private isDecompressed: boolean;
private decompressIfNeeded(): void;
private processDecompressedTransactions(session: CompressedSession): void;
getEligibleSessionsForCompression(): SessionID[];

// crypto.ts — CryptoProvider gains:
lz4Compress(data: Uint8Array): Uint8Array;
lz4Decompress(data: Uint8Array): { ok: boolean; data: Uint8Array };
```

## Testing Strategy

We prioritize integration testing. Tests validate the full lifecycle of compression — creation, sync, lazy decompression, and state resolution.

### Test 1: Compression preserves group state after decompression

```typescript
test("compressing and decompressing preserves group state", async () => {
  const { node: adminNode } = await setupTestNode();
  const group = adminNode.createGroup();

  // Add members (creates key revelations in various sessions)
  const member1 = await createTestNode();
  const member2 = await createTestNode();
  group.addMember(member1.account, "writer");
  group.addMember(member2.account, "reader");

  // Capture state before compression
  const readKeyBefore = group.getCurrentReadKey();
  const sessionCountBefore = group.core.verified.sessionCount;

  // Compress eligible sessions
  const eligible = group.getEligibleSessionsForCompression();
  expect(eligible.length).toBeGreaterThan(0);
  group.core.compressGroup(eligible);

  // Session count should decrease (compressed sessions pruned)
  expect(group.core.verified.sessionCount).toBeLessThan(sessionCountBefore);

  // Trigger decompression by looking up a key
  const readKeyAfter = group.getCurrentReadKey();
  expect(readKeyAfter).toEqual(readKeyBefore);
});
```

### Test 2: Compressed sessions excluded from KnownState and sync

```typescript
test("compressed sessions are excluded from sync", async () => {
  const { node: adminNode } = await setupTestNode();
  const group = adminNode.createGroup();
  group.addMember(member1.account, "writer");

  const eligible = group.getEligibleSessionsForCompression();
  group.core.compressGroup(eligible);

  const knownState = group.core.knownState();
  for (const session of eligible) {
    expect(knownState.sessions).not.toHaveProperty(session);
  }

  // New content messages should not include compressed sessions
  const content = group.core.verified.newContentSince(undefined);
  for (const msg of content) {
    for (const session of eligible) {
      expect(msg.new).not.toHaveProperty(session);
    }
  }
});
```

### Test 3: Late transactions on compressed sessions are rejected

```typescript
test("new transactions on compressed sessions are rejected", async () => {
  const { node: adminNode } = await setupTestNode();
  const group = adminNode.createGroup();
  group.addMember(member1.account, "writer");

  const eligible = group.getEligibleSessionsForCompression();
  const targetSession = eligible[0];
  group.core.compressGroup(eligible);

  const result = group.core.tryAddTransactions(
    targetSession,
    [makeTrustingTransaction({ op: "set", key: "readKey", value: "key_z..." })],
    fakeSignature,
  );

  expect(result).toMatchObject({ type: "CompressedSessionRejected" });
});
```

### Test 4: Role-based eligibility excludes admin/manager/invite sessions

```typescript
test("admin and manager sessions are not eligible for compression", async () => {
  const { node: adminNode } = await setupTestNode();
  const group = adminNode.createGroup();
  const manager = await createTestNode();
  group.addMember(manager.account, "manager");
  group.addMember(member1.account, "writer");

  const eligible = group.getEligibleSessionsForCompression();

  // Admin and manager sessions should not be eligible
  const adminSession = adminNode.currentSessionID;
  const managerSession = getSessionForAccount(group, manager.account);
  expect(eligible).not.toContain(adminSession);
  expect(eligible).not.toContain(managerSession);

  // Writer session should be eligible
  const writerSession = getSessionForAccount(group, member1.account);
  expect(eligible).toContain(writerSession);
});
```

### Test 5: On-demand decompression triggers only when needed

```typescript
test("decompression is lazy — only triggered on data lookup", async () => {
  const { node: adminNode } = await setupTestNode();
  const group = adminNode.createGroup();
  group.addMember(member1.account, "writer");

  group.core.compressGroup(group.getEligibleSessionsForCompression());

  // Before any key lookup, blobs remain pending
  expect(group.pendingCompressedBlobs.length).toBeGreaterThan(0);

  // Trigger decompression via key lookup
  group.getCurrentReadKey();

  // After lookup, blobs are decompressed
  expect(group.pendingCompressedBlobs.length).toBe(0);
  expect(group.isDecompressed).toBe(true);
});
```

### Test 6: Concurrent compressions merge correctly

```typescript
test("concurrent compressions from two admins both apply", async () => {
  // Setup: two admins, multiple writer members
  // Admin1 compresses sessions [S1, S2]
  // Admin2 compresses sessions [S2, S3]
  // Both compression markers are synced to a third node

  // After sync: S1, S2, S3 all pruned from knownState
  // Decompression yields correct state regardless of ingestion order
  const stateAfter = captureGroupState(group);
  expect(stateAfter).toEqual(stateBefore);
});
```
