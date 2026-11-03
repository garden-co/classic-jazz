# Design: Conflicting Session Logs Recovery

## Overview

This design addresses the recovery mechanism for conflicting session logs that occur when multiple instances reuse the same session ID. The solution detects conflicts on the sync server when signature verification fails, sends authenticated corrections to clients, and allows clients to remove their conflicting sessions and accept the server's authoritative version.

The design leverages existing content correction mechanisms (`isCorrection: true`) and adds specific handling for session log conflicts. The key insight is that only the session owner can resolve conflicts, and the server's version is considered authoritative.

## Architecture / Components

### 1. Conflict Detection (Sync Server)

**Location**: `packages/cojson/src/sync.ts` - `SyncManager.handleNewContent()`

**Changes**:
- When `tryAddTransactions()` returns an `InvalidSignatureError` for a session:
  1. If the peer is a client (not server), treat as a potential session conflict
  2. Send a content correction message (`NewContentMessage` with `isCorrection: true`) containing the full history of the conflicting session from the server

**Key Logic**:
```typescript
if (error?.type === "InvalidSignature" && peer?.role === "client") {
  // Send correction with server's full session history
  this.sendSessionCorrection(msg.id, sessionID, peer, coValue);
}
```

**Correction Message Structure**:
- The correction is a `NewContentMessage` with `isCorrection: true`
- It contains the complete session history for the conflicting session from the server's perspective
- The `new[sessionID]` field includes all transactions from the session with `after: 0` (or appropriate starting index)
- This allows the client to receive the authoritative server version of the session log

### 2. Correction Message Verification (Client)

**Location**: `packages/cojson/src/sync.ts` - `SyncManager.handleNewContent()`

**Changes**:
- When receiving a `NewContentMessage` with `isCorrection: true`:
  1. Extract which session(s) are being corrected from the message
  2. Check if the client owns the conflicting session (using `accountOrAgentIDfromSessionID()` and comparing with local node's current account/agent)
  3. If owned, verify the correction signatures (transactions must have valid signatures)
  4. If valid, proceed to session removal and replacement workflow

**Verification**:
- Corrections come from trusted server peers
- Server corrections contain the full session history with cryptographically verifiable signatures
- Client verifies that the correction is for a session it actually owns before accepting
- Each transaction in the correction message must have valid signatures

### 3. Session Removal (Client)

**Location**: `packages/cojson/src/coValueCore/SessionMap.ts` and `packages/cojson/src/coValueCore/coValueCore.ts`

**Changes**:
- Add method `removeSession(sessionID: SessionID)` to `SessionMap`:
  - Removes session from `sessions` Map
  - Updates `knownState.sessions` to remove the session counter
  - Invalidates known state cache

- In `CoValueCore`, add method `removeConflictingSession(sessionID: SessionID)`:
  - Verifies session ownership
  - Calls `SessionMap.removeSession()`
  - Clears any errored state for the session
  - Re-processes transactions if needed

**Flow**:
```typescript
// In handleNewContent when receiving correction
if (msg.isCorrection) {
  for (const sessionID in msg.new) {
    if (isClientSessionConflict(sessionID, localNode)) {
      const coValue = localNode.getCoValue(msg.id);
      coValue.removeConflictingSession(sessionID);
      // Apply server's state - handle correction message normally
      // which will add the server's session transactions
    }
  }
}
```

### 4. Session Removal (Storage)

**Location**: `packages/cojson/src/storage/storageSync.ts` and `packages/cojson/src/storage/storageAsync.ts`

**Changes**:
- When a session is removed from memory and replaced by correction:
  1. The correction `NewContentMessage` with `isCorrection: true` is stored via normal `store()` flow
  2. Storage should detect that this is a correction for a conflicting session
  3. Delete existing session rows for the conflicting session before applying the correction
  4. Store the server's session history from the correction message
  5. Update known state to reflect the server's session state

**Database Operations**:
- Delete conflicting session rows: `dbClient.deleteSession(coValueRowID, sessionID)`
- Store correction content: Process correction message normally, storing all transactions from server's session history
- Update known state: Reflect the server's session counter in stored known state
- Ensure consistency when loading coValue later - server's version should be loaded

### 5. Apply Server Session State (Client)

**Location**: `packages/cojson/src/sync.ts` and `packages/cojson/src/coValueCore/coValueCore.ts`

**Changes**:
- After removing conflicting session, apply the server's session state:
  1. The correction `NewContentMessage` contains the full session history in `new[sessionID]`
  2. After removing the conflicting session, process the correction message normally via `handleNewContent()`
  3. The correction message will add the server's version of the session with all its transactions
  4. The server's session log replaces the client's conflicting version

**Implementation**:
- Correction message contains full session history with `after: 0` (or appropriate index)
- After session removal, the correction message is processed through normal `handleNewContent()` flow
- `tryAddTransactions()` will successfully add the server's transactions since the conflicting local session is removed
- The server's authoritative session log becomes the active session in the coValue

## Data Models

### Session Conflict Detection

```typescript
type SessionConflictContext = {
  coValueID: RawCoID;
  sessionID: SessionID;
  sessionOwnerID: RawAccountID | AgentID;
  serverKnownState: CoValueKnownState;
  clientPeerID: PeerID;
};
```

### Correction Message (Enhanced)

The `NewContentMessage` type is extended with an optional `isCorrection` field.

```typescript
type NewContentMessage = {
  action: "content";
  id: RawCoID;
  header?: CoValueHeader;
  priority: CoValuePriority;
  new: {
    [sessionID: SessionID]: SessionNewContent;
  };
  expectContentUntil?: KnownStateSessions;
  isCorrection?: boolean; // true for corrections - contains full session history
};

type SessionNewContent = {
  after: number; // Starting index (typically 0 for full history in corrections)
  newTransactions: Transaction[]; // All transactions in the session
  lastSignature: Signature; // Final signature for verification
};
```

### Session Removal Metadata (Internal)

```typescript
type SessionRemovalResult = {
  removedSessionID: SessionID;
  coValueID: RawCoID;
  newSessionID?: SessionID; // If new session was created
};
```

## Error Handling / Testing Strategy

### Error Cases

1. **False Positive Detection**: 
   - If signature verification fails for non-conflict reasons (e.g., malicious peer, data corruption)
   - **Handling**: Server sends correction for any invalid signature from client. Client only accepts correction if it owns the session
   - **Test**: Send invalid signatures from non-owned sessions, verify server sends correction but client rejects it

2. **Correction Verification Failure**:
   - If correction message signature is invalid
   - **Handling**: Reject correction, log error, don't remove session
   - **Test**: Send malformed corrections, verify rejection

3. **Session Not Found During Removal**:
   - If trying to remove a session that doesn't exist locally
   - **Handling**: No-op, continue with applying server state
   - **Test**: Remove non-existent session, verify graceful handling

4. **Storage Removal Failure**:
   - If database operation fails during session removal
   - **Handling**: Log error, but continue - memory state is already updated
   - **Test**: Simulate storage failures, verify graceful degradation

5. **Partial Removal**:
   - If removal succeeds in memory but fails in storage
   - **Handling**: On next load, storage will request correction again, re-triggering removal
   - **Test**: Simulate partial failures, verify eventual consistency

### Testing Strategy

1. **Unit Tests**:
   - `SessionMap.removeSession()` - verify session removal and state updates
   - `CoValueCore.removeConflictingSession()` - verify ownership check and removal
   - Conflict detection logic - verify detection conditions
   - Correction verification - verify signature checks

2. **Integration Tests**:
   - End-to-end conflict scenario: Create conflict, verify detection, verify correction flow
   - Multiple coValues with same session: Verify only affected session is removed
   - Storage persistence: Verify removed session stays removed after reload
   - New session creation: Verify new transactions use new session ID

3. **Edge Case Tests**:
   - Concurrent corrections: What happens if multiple corrections arrive?
   - Corrections for multiple sessions: Handle bulk session conflicts
   - Corrections during active transactions: Ensure no data loss
   - Network failures during correction: Verify retry/consistency

4. **Stress Tests**:
   - Many conflicting sessions across multiple coValues
   - Rapid conflict detection and resolution
   - Storage performance with session removals

### Test Scenarios

**Scenario 1: Basic Conflict Resolution**
1. Client A creates transactions in session S
2. Client B reuses session S (simulated conflict)
3. Client A sends updates to server
4. Server detects invalid signature for session S
5. Server sends `NewContentMessage` with `isCorrection: true` containing full session S history from server
6. Client A verifies correction and checks it owns session S
7. Client A removes conflicting session S from local state
8. Client A applies server's session S history from correction message
9. Client A creates new session for future transactions
10. Verify no data loss, server state preserved

**Scenario 2: Multiple CoValues Affected**
1. Session S has transactions in CoValue C1 and C2
2. Conflict detected for session S
3. Verify session S is removed from both C1 and C2
4. Verify server state applied to both

**Scenario 3: Storage Persistence**
1. Trigger conflict resolution
2. Session removed from memory and storage
3. Reload coValue from storage
4. Verify removed session is not restored
5. Verify server state is correctly loaded

