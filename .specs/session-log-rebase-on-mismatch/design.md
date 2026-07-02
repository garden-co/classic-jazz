# Design: Signature Mismatch Recovery via Conflict Session

## Overview

When the sync server detects a signature mismatch for a client-submitted transaction, the client recovers by:

1. Moving divergent local transactions to a **conflict session** (a new session derived from the original).
2. **Replacing** the conflicting session in storage and memory with the server's authoritative version.
3. Letting CRDT semantics merge the conflict session's operations with the authoritative history.

This avoids the complexity of temporary nodes, atomic storage replacement, encrypted transaction replay, and dependency resolution from the previous design.

### Root Cause

A race condition between peer sync and local persistence:

1. `makeTransaction()` signs a transaction, adds it to in-memory verified state, and queues sync.
2. `LocalTransactionsSyncQueue` batches via `queueMicrotask`. Within that microtask, `syncContent()` calls both `storeContent()` (local persistence via async queue) and `trySendToPeer()` (immediate remote send).
3. The cloud server receives and stores the transaction with signature S1 at position N.
4. If the client crashes before storage finishes writing, the transaction exists on the cloud but not in local storage.
5. On restart, local storage loads up to position N-1. The client creates new transactions starting from N with a different signature S2.
6. The server rejects S2 — signature mismatch.

```
T0: Client creates tx[N], signs with S1, sends to cloud
T1: Cloud stores tx[N] with S1
T2: Client crashes BEFORE persisting tx[N] locally
T3: Client restarts, loads storage (has tx[0..N-1] only)
T4: Client creates tx[N] with NEW content, signs with S2
T5: Client syncs -> Cloud rejects: expected S1 continuation, got S2
```

## Architecture

### 1. Protocol Extension

New sync error message type:

```ts
type SignatureMismatchErrorMessage = {
  action: "error";
  errorType: "SignatureMismatch";
  id: RawCoID;
  sessionID: SessionID;
  content: SessionNewContent[]; // authoritative session content from server
  reason: string;
};
```

The server sends the full authoritative session content so the client can compute the divergence point (common prefix) between local and server state.

### 2. Server Flow

On signature verification failure in the `handleNewContent` path:

1. Stop processing the invalid transaction batch for that session.
2. **Do not call `markErrored`** — the CoValue must remain syncable for recovery.
3. Build authoritative session content via `coValue.verified.getFullSessionContent(sessionID)`.
4. Send `SignatureMismatchErrorMessage` back to the originating peer.
5. De-duplicate by `(peerId, coValueId, sessionID)` via `peer.shouldSendSignatureMismatch()`.
6. Continue processing remaining valid sessions in the message (use `continue`, not `return`).

### 3. Client Recovery Flow

Recovery is orchestrated by `recoverSignatureMismatch()` in `recovery/index.ts`.

#### 3.1 Ownership Check

Only the session owner can recover. Ownership is checked via `accountOrAgentIDfromSessionID()`:

```ts
function isCurrentNodeSessionOwner(local: LocalNode, sessionID: SessionID): boolean {
  const sessionOwner = accountOrAgentIDfromSessionID(sessionID);
  return (
    sessionOwner === local.getCurrentAccountOrAgentID() ||
    sessionOwner === local.getCurrentAgent().id
  );
}
```

Non-owner sessions: log and no-op (deferred to a future iteration).

#### 3.2 Compute Divergent Transactions

1. Normalize authoritative content: sort by `after`, validate continuity, flatten into a transaction list.
2. Compare with local session transactions to find the **common prefix** (using transaction equality: privacy, madeAt, keyUsed, changes, meta).
3. Local transactions after the common prefix are the **divergent transactions**.
4. Read their parsed changes from the in-memory `parsingCache` — they were created via `makeTransaction()` post-restart, so they are always cached.

#### 3.3 Create Conflict Session

For each divergent transaction, call `makeTransaction()` with the `isConflict` option set to `true`.

When `isConflict` is true, `makeTransaction()` derives a **conflict session ID** from the current session ID instead of using it directly. The conflict session ID is formed by modifying the last byte of the current session ID to flag it as a conflict (similar to how delete sessions use `_session_d` prefix and `$` suffix).

The conflict session transactions go through the normal sync path:
- Stored locally via the standard storage queue.
- Sent to peers via `trySendToPeer()`.
- The server accepts them since it's a new session with no signature conflicts.

#### 3.4 Wait for Storage Sync

Call `syncManager.waitForStorageSync(id)` — this resolves when the storage's known state catches up with the in-memory known state. This ensures the conflict session is durably persisted before modifying the original session.

#### 3.5 Replace Session in CoValue

Two operations, storage then memory:

**Storage:**
Within a single database transaction:
1. Delete the conflicting session's transactions, signatures, and session row.
2. Write the authoritative content as new session rows via `putNewTxs`.

**Memory:**
Call `CoValueCore.replaceSessionContent(sessionID, authoritativeContent)`:
1. Create a fresh `VerifiedState` with the same header.
2. Replay all sessions from the current verified state into it, **except** for the conflicting session where the authoritative content is used instead.
3. Swap `_verified` pointer.
4. Reset derived transaction state (caches, branches, merges, FWW winners).
5. Rebuild cached content, notify subscribers, invalidate dependants.
6. Sync the updated state to all peers.

After this step, the CoValue has:
- The correct authoritative session from the server.
- The conflict session with the divergent operations.
- CRDT semantics merge them naturally — the divergent operations are treated as concurrent edits.

### 4. Conflict Session ID

Conflict session IDs are derived deterministically from the original session ID. This makes recovery idempotent: if recovery runs twice for the same session, the same conflict session ID is produced.

```ts
type ConflictSessionID = `${RawAccountID | AgentID}_session_z${string}!`;
```

The `!` suffix (or similar marker) distinguishes conflict sessions from normal active sessions. A helper `isConflictSessionID()` checks for this marker, and `toConflictSessionID()` derives it from an `ActiveSessionID`.

### 5. `makeTransaction()` Changes

`makeTransaction()` accepts a new optional `isConflict` boolean parameter. When true:

```ts
if (isConflict) {
  sessionID = toConflictSessionID(sessionID);
}
```

This is inserted in the session ID resolution block alongside the existing delete session and account session logic.

## New Methods

| Method | Location | Purpose |
|--------|----------|---------|
| `getFullSessionContent(sessionID)` | `VerifiedState` | Extract complete session history as `SessionNewContent[]` |
| `shouldSendSignatureMismatch(id, sessionID)` | `PeerState` | De-duplication guard for mismatch errors |
| `replaceSessionContent(sessionID, content)` | `CoValueCore` | Rebuild VerifiedState with authoritative session, swap, notify |
| `toConflictSessionID(sessionID)` | `ids.ts` | Derive conflict session ID from active session ID |
| `isConflictSessionID(sessionID)` | `ids.ts` | Check if a session ID is a conflict session |
| `deleteTransactionsForSession(rowID)` | DB transaction interfaces | Delete session's transactions (already in interface) |
| `deleteSignaturesForSession(rowID)` | DB transaction interfaces | Delete session's signatures (already in interface) |
| `deleteSession(rowID)` | DB transaction interfaces | Delete session row (already in interface) |

## Recovery State Machine

Per `(coValueId, sessionID)`:

```
Idle
  -> OwnerCheck
    -> ComputeDivergence
      -> CreateConflictSession
        -> WaitForStorageSync
          -> ReplaceSession (storage + memory)
            -> Completed
```

Any step can transition to `Failed`. The CoValue remains usable in the `Failed` case — the original state is preserved until the replace step succeeds.

De-duplication: an `activeRecoveries` set keyed by `${id}::${sessionID}` prevents concurrent recovery for the same session.

Idempotency: if recovery runs again for the same session (e.g., after a crash mid-recovery), the conflict session ID is deterministic. Before creating conflict session transactions, check if the conflict session already has transactions in the verified state — if so, skip step 3.3 and proceed directly to the replace step.

## Testing Strategy

### Integration Tests

1. **Server sends authoritative session on signature mismatch**
   - Client submits invalid signature for session S.
   - Server sends `SignatureMismatchErrorMessage` with authoritative content.
   - Server does NOT call `markErrored`.
   - Server continues processing other valid sessions in the same message.

2. **Non-owner is no-op**
   - Client is not owner of session S and receives mismatch error.
   - No recovery runs; local state unchanged.

3. **Divergent transactions move to conflict session**
   - Owner receives mismatch error.
   - Divergent local transactions appear on a conflict session.
   - Original session is replaced with authoritative content.
   - Both sessions are present and CRDT-merged.

4. **Convergence after recovery**
   - After recovery, all peers converge.
   - No repeated signature mismatch loop.

5. **Recovery idempotency**
   - If recovery triggers twice for the same session, the same conflict session ID is used.
   - No duplicate conflict sessions.

6. **Storage durability**
   - Conflict session is persisted before original session is replaced.
   - Crash after conflict session persistence but before replacement: next restart recovers again (divergent txs already on conflict session are skipped, original session replacement retried).

## Non-goals (This Iteration)

- Preventing the root cause race condition (sync-before-persist ordering).
- Non-owner session replacement.
- Compacting/merging conflict sessions after recovery.
