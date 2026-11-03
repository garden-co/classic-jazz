# Design: Storage Size Limits with Intelligent Eviction

## Overview

This design implements configurable storage size limits with a hybrid LRU + size-based eviction strategy. The system enforces a hard storage limit, ensuring the database never exceeds the configured maximum. It integrates with the existing `GarbageCollector` and `UnsyncedCoValuesTracker` infrastructure to coordinate memory and storage lifecycle.

### Key Design Principles

1. **Hard limit enforcement** - Storage must NEVER exceed `maxStorageBytes`
2. **Check before write** - Validate space availability before storing
3. **Protect active data** - Never evict in-memory or unsynced CoValues
4. **Unified timestamps** - Update `GarbageCollector` to use `Date.now()` so `lastAccessed` can be persisted and reused for storage eviction
5. **Minimize overhead** - Efficient size tracking, batched operations

---

## Architecture

```
┌──────────────────────────────────────────────────────────────────────────────┐
│                              LocalNode                                        │
│  ┌─────────────────┐  ┌─────────────────────┐  ┌──────────────────────────┐  │
│  │ GarbageCollector│  │ StorageEvictionMgr  │  │ UnsyncedCoValuesTracker  │  │
│  │ (in-memory GC)  │  │ (storage eviction)  │  │ (sync tracking)          │  │
│  │                 │  │                     │  │                          │  │
│  │ tracks:         │  │ enforces:           │  │ tracks:                  │  │
│  │ lastAccessed    │  │ - hard limit        │──►│ - unsynced CoValue IDs   │  │
│  │ (Date.now())    │  │ - eviction scoring  │  │                          │  │
│  └────────┬────────┘  └──────────┬──────────┘  └──────────────────────────┘  │
│           │                      │                                            │
│           │ persisted            │ evict/store                                │
│           ▼                      ▼                                            │
│  ┌───────────────────────────────────────────────────────────────────────┐   │
│  │                         StorageAPI                                     │   │
│  │  ┌─────────────────────────────────────────────────────────────────┐  │   │
│  │  │                    Eviction Metadata                             │  │   │
│  │  │  - last_accessed (from GC, persisted on store)                  │  │   │
│  │  │  - size_bytes (per CoValue)                                     │  │   │
│  │  └─────────────────────────────────────────────────────────────────┘  │   │
│  │  ┌─────────────────────────────────────────────────────────────────┐  │   │
│  │  │                    CoValue Data                                  │  │   │
│  │  │  - coValues, sessions, transactions, signatureAfter             │  │   │
│  │  └─────────────────────────────────────────────────────────────────┘  │   │
│  └───────────────────────────────────────────────────────────────────────┘   │
└──────────────────────────────────────────────────────────────────────────────┘
```

**Key change:** `GarbageCollector` now uses `Date.now()` instead of `performance.now()`. This allows `verified.lastAccessed` to be persisted directly to storage and reused for eviction scoring. The GC only cares about relative time differences, so `Date.now()` works correctly for both purposes.

---

## Flow Diagrams

### 1. Store Operation Flow

This flow is triggered when new content needs to be stored:

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                           STORE OPERATION FLOW                               │
└─────────────────────────────────────────────────────────────────────────────┘

  store(msg) called
        │
        ▼
┌───────────────────┐
│ Estimate write    │
│ size from msg     │
└─────────┬─────────┘
          │
          ▼
┌───────────────────┐     ┌──────────────────────────────────────────────────┐
│ evictionManager.  │     │                                                  │
│ ensureSpaceFor    │────►│  ┌─────────────────────────────────────────┐    │
│ Write(writeSize)  │     │  │ Get current storage size                │    │
└─────────┬─────────┘     │  │ (PRAGMA page_count * page_size)         │    │
          │               │  └───────────────┬─────────────────────────┘    │
          │               │                  ▼                               │
          │               │  ┌─────────────────────────────────────────┐    │
          │               │  │ availableSpace = maxBytes - currentSize │    │
          │               │  └───────────────┬─────────────────────────┘    │
          │               │                  ▼                               │
          │               │         writeSize <= availableSpace?             │
          │               │              /           \                       │
          │               │           YES             NO                     │
          │               │            │               │                     │
          │               │            ▼               ▼                     │
          │               │    return true    ┌───────────────────┐         │
          │               │         │         │ evictToFreeSpace  │         │
          │               │         │         │ (bytesNeeded)     │         │
          │               │         │         └─────────┬─────────┘         │
          │               │         │                   │                    │
          │               │         │                   ▼                    │
          │               │         │         freedBytes >= needed?          │
          │               │         │              /           \             │
          │               │         │           YES             NO           │
          │               │         │            │               │           │
          │               │         │            ▼               ▼           │
          │               │         │     return true    throw error        │
          │               │         │            │        (StorageFull)     │
          │               └─────────┼────────────┼───────────────┼──────────┘
          │                         │            │               │
          ▼                         ▼            ▼               ▼
┌───────────────────┐        ┌─────────────────────────┐  ┌──────────────┐
│ canStore = true?  │◄───────┤     canStore = true     │  │ ERROR thrown │
└─────────┬─────────┘        └─────────────────────────┘  └──────────────┘
          │
          ▼
┌─────────┐
│ Store   │
│ to DB   │
└────┬────┘
     │
     ▼
┌─────────────────────────────┐
│ Update eviction metadata:   │
│ - lastAccessed (from GC)    │
│ - sizeBytes += newSize      │
└─────────────────────────────┘
```

### 2. Eviction Process Flow

This flow shows how `evictToFreeSpace` works:

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                           EVICTION PROCESS FLOW                              │
└─────────────────────────────────────────────────────────────────────────────┘

  evictToFreeSpace(bytesNeeded) called
        │
        ▼
┌───────────────────────────────────────────────────────────────┐
│                    GET EVICTION CANDIDATES                     │
│                                                                │
│  1. Get unsynced IDs from UnsyncedCoValuesTracker (in-memory) │
│  2. Get in-memory IDs from LocalNode.coValues                  │
│  3. Combine into protectedIds set                              │
│  4. Query storage for candidates NOT in protectedIds           │
│  5. Calculate eviction score for each candidate                │
│  6. Sort by score DESC (highest = evict first)                 │
└───────────────────────────────────────────────────────────────┘
        │
        ▼
┌───────────────────┐
│ candidates.length │
│ > 0 ?             │
└─────────┬─────────┘
          │
    ┌─────┴─────┐
   YES          NO
    │            │
    │            ▼
    │    ┌─────────────────────────────┐
    │    │ return 0                    │
    │    │ (no candidates to evict,    │
    │    │  graceful degradation)      │
    │    └─────────────────────────────┘
    │
    ▼
┌─────────────────────────────────────────────────────────────┐
│                    EVICTION LOOP                             │
│                                                              │
│   freedBytes = 0                                             │
│   batch = []                                                 │
│                                                              │
│   for candidate in candidates:                               │
│       │                                                      │
│       ▼                                                      │
│   ┌───────────────────────────┐                              │
│   │ batch.push(candidate.id)  │                              │
│   │ freedBytes += sizeBytes   │                              │
│   └─────────────┬─────────────┘                              │
│                 │                                            │
│                 ▼                                            │
│       batch.length >= batchSize?                             │
│            /           \                                     │
│         YES             NO                                   │
│          │               │                                   │
│          ▼               │                                   │
│   ┌──────────────┐       │                                   │
│   │ Flush batch  │       │                                   │
│   │ (delete from │◄──────┘                                   │
│   │  storage)    │                                           │
│   └──────┬───────┘                                           │
│          │                                                   │
│          ▼                                                   │
│   freedBytes >= bytesNeeded?                                 │
│        /           \                                         │
│     YES             NO                                       │
│      │               │                                       │
│      ▼               └──────► continue loop                  │
│   BREAK                                                      │
│                                                              │
└──────────────────────────────────┬───────────────────────────┘
                                   │
                                   ▼
                    ┌──────────────────────────┐
                    │ Flush remaining batch    │
                    └────────────┬─────────────┘
                                 │
                                 ▼
                    ┌──────────────────────────┐
                    │ return freedBytes        │
                    └──────────────────────────┘
```

### 3. Delete CoValue Flow

This flow shows what happens when evicting a single CoValue:

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                         DELETE COVALUE FLOW                                  │
└─────────────────────────────────────────────────────────────────────────────┘

  deleteCoValue(id) called
        │
        ▼
┌─────────────────────────────────────────────────────────────┐
│                  DELETE FROM DATABASE                        │
│                                                              │
│  1. DELETE FROM covalue_eviction_metadata WHERE id = ?       │
│  2. DELETE FROM transactions WHERE ses IN (session_ids)      │
│  3. DELETE FROM signatureAfter WHERE ses IN (session_ids)    │
│  4. DELETE FROM sessions WHERE coValue = ?                   │
│  5. DELETE FROM coValues WHERE id = ?                        │
│                                                              │
│  (All in single transaction for consistency)                 │
└───────────────────────────────────────────────────────────────┘
        │
        ▼
┌─────────────────────────────────────────────────────────────┐
│              CLEAR FROM KNOWN STATE CACHE                    │
│                                                              │
│  knownStates.clearKnownState(id)                            │
│    - Remove from knownStates Map                            │
│    - Resolve any pending waitForSync requests               │
│                                                              │
└───────────────────────────────────────────────────────────────┘
        │
        ▼
┌─────────────────────────────────────────────────────────────┐
│  CoValue is now fully evicted:                               │
│  - Not in storage                                           │
│  - Not in known state cache                                 │
│  - Can be re-fetched from server on next access             │
└─────────────────────────────────────────────────────────────┘
```

### 4. Background Eviction Flow

This flow runs periodically (default: every 5 minutes):

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                      BACKGROUND EVICTION FLOW                                │
└─────────────────────────────────────────────────────────────────────────────┘

  setInterval callback (every evictionIntervalMs)
        │
        ▼
┌───────────────────────────────────┐
│ Get current storage size          │
└─────────────────┬─────────────────┘
                  │
                  ▼
┌───────────────────────────────────┐
│ currentSize > softThreshold?      │
│ (softThreshold = max * 0.8)       │
└─────────────────┬─────────────────┘
                  │
            ┌─────┴─────┐
           YES          NO
            │            │
            │            ▼
            │     ┌──────────────┐
            │     │ Do nothing   │
            │     │ (enough      │
            │     │  headroom)   │
            │     └──────────────┘
            │
            ▼
┌───────────────────────────────────────────┐
│ Proactive eviction:                        │
│ bytesToFree = currentSize - softThreshold │
│ evictToFreeSpace(bytesToFree)             │
└───────────────────────────────────────────┘
        │
        ▼
┌───────────────────────────────────────────┐
│ Log eviction stats:                        │
│ - Bytes freed                             │
│ - CoValues evicted                        │
│ - New storage size                        │
└───────────────────────────────────────────┘
```

### 5. Overall System Integration

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                          SYSTEM INTEGRATION                                  │
└─────────────────────────────────────────────────────────────────────────────┘

                        ┌─────────────────────┐
                        │     LocalNode       │
                        └──────────┬──────────┘
                                   │
           ┌───────────────────────┼───────────────────────┐
           │                       │                       │
           ▼                       ▼                       ▼
┌─────────────────────┐ ┌─────────────────────┐ ┌─────────────────────┐
│  GarbageCollector   │ │ StorageEvictionMgr  │ │UnsyncedCoValues     │
│  (in-memory GC)     │ │ (storage eviction)  │ │Tracker              │
│                     │ │                     │ │                     │
│ - Unmounts CoValues │ │ - Checks protectedI │ │ - Tracks unsynced   │
│   from memory after │ │   from both GC and  │◄│   CoValue IDs       │
│   MAX_AGE           │ │   UnsyncedTracker   │ │ - Used to protect   │
│ - Makes CoValues    │ │ - Evicts only safe  │ │   from eviction     │
│   eligible for      │ │   candidates        │ │                     │
│   storage eviction  │ │                     │ │                     │
└─────────────────────┘ └──────────┬──────────┘ └─────────────────────┘
                                   │
                                   ▼
                        ┌─────────────────────┐
                        │     StorageAPI      │
                        │  (SQLite/IndexedDB) │
                        │                     │
                        │ - store()           │
                        │ - load()            │
                        │ - deleteCoValue()   │
                        │ - getStorageSize()  │
                        │ - getEvictionMeta() │
                        └─────────────────────┘

LIFECYCLE OF A COVALUE:

  Created ──► In Memory ──► Synced to Server ──► Unmounted by GC ──► Evicted
     │            │               │                    │                │
     │            │               │                    │                │
     ▼            ▼               ▼                    ▼                ▼
  Protected   Protected      Protected            EVICTABLE         Gone from
  (unsynced)  (in-memory)    (in-memory)     (not in memory,       storage
                                               synced)              (can re-fetch)
```

---

## Eviction Safeguards

To prevent eviction from getting stuck or causing performance issues, the system implements several safeguards:

### 1. Eviction Mutex (Prevent Concurrent Eviction)

```typescript
class StorageEvictionManager {
  private evictionInProgress: boolean = false;
  
  async evictToFreeSpace(bytesNeeded: number): Promise<number> {
    // Prevent concurrent eviction (background + store could collide)
    if (this.evictionInProgress) {
      logger.debug("Eviction already in progress, skipping");
      return 0;
    }
    
    this.evictionInProgress = true;
    try {
      return await this.doEviction(bytesNeeded);
    } finally {
      this.evictionInProgress = false;
    }
  }
}
```

### 2. Maximum Candidates Limit

```typescript
async getEvictionCandidates(): Promise<EvictionCandidate[]> {
  const candidates = await this.storage.getEvictionCandidates(protectedIds);
  
  // Limit candidates to prevent processing too many at once
  // This bounds memory usage and processing time
  return candidates.slice(0, this.config.maxEvictionCandidates);  // default: 1000
}
```

### 3. Early Exit Conditions

```typescript
async doEviction(bytesNeeded: number): Promise<number> {
  const candidates = await this.getEvictionCandidates();
  
  // Exit 1: No candidates available
  if (candidates.length === 0) {
    logger.warn("No eviction candidates available");
    return 0;
  }
  
  // Exit 2: Calculate total evictable space upfront
  const totalEvictableBytes = candidates.reduce((sum, c) => sum + c.sizeBytes, 0);
  if (totalEvictableBytes < bytesNeeded) {
    logger.warn("Not enough evictable space", { 
      needed: bytesNeeded, 
      available: totalEvictableBytes 
    });
    // Still evict what we can, but caller knows we couldn't free enough
  }
  
  let freedBytes = 0;
  let evictedCount = 0;
  
  for (const candidate of candidates) {
    // Exit 3: We've freed enough
    if (freedBytes >= bytesNeeded) {
      break;
    }
    
    await this.deleteCoValue(candidate.id);
    freedBytes += candidate.sizeBytes;
    evictedCount++;
    
    // Exit 4: Batch limit reached (yield to other operations)
    if (evictedCount >= this.config.evictionBatchSize) {
      break;
    }
  }
  
  return freedBytes;
}
```

### 4. Background Eviction Skip During Store

```typescript
// Background eviction checks if store eviction is happening
async backgroundEvictionCheck(): Promise<void> {
  if (this.evictionInProgress) {
    // Store eviction is running, skip this background check
    return;
  }
  
  const currentSize = await this.getCurrentStorageSize();
  const softThreshold = this.config.maxStorageBytes * this.config.softThresholdRatio;
  
  if (currentSize > softThreshold) {
    await this.evictToFreeSpace(currentSize - softThreshold);
  }
}
```

### 5. Graceful Degradation Summary

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                     EVICTION TERMINATION CONDITIONS                          │
└─────────────────────────────────────────────────────────────────────────────┘

  evictToFreeSpace() will ALWAYS terminate because:
  
  1. MUTEX: Only one eviction can run at a time
     └─► Concurrent calls return 0 immediately
  
  2. FINITE CANDIDATES: Limited to maxEvictionCandidates (default 1000)
     └─► Can't loop forever through infinite candidates
  
  3. BATCH LIMIT: Evicts at most evictionBatchSize per call (default 100)
     └─► Prevents long-running transactions
  
  4. EARLY EXIT: Stops when freedBytes >= bytesNeeded
     └─► Doesn't evict more than necessary
  
  5. NO CANDIDATES: Returns 0 when no evictable CoValues exist
     └─► Caller throws StorageFullError
  
  6. INSUFFICIENT SPACE: Returns freedBytes < bytesNeeded
     └─► Caller throws StorageFullError

  Result: Eviction NEVER loops infinitely. Worst case is:
  - Process maxEvictionCandidates candidates
  - In batches of evictionBatchSize
  - Then return and let caller throw error if insufficient
```

---

## Components

### 1. StorageEvictionManager

**Location:** `packages/cojson/src/storage/StorageEvictionManager.ts`

**Responsibilities:**
- Monitor storage size and enforce hard limits
- Calculate eviction scores (LRU + size hybrid)
- Coordinate with GarbageCollector and UnsyncedCoValuesTracker
- Trigger proactive and immediate eviction

```typescript
interface StorageEvictionConfig {
  maxStorageBytes: number;          // Hard limit (default: 5GB)
  softThresholdRatio: number;       // Proactive eviction threshold (default: 0.8)
  ageWeight: number;                // Weight for age in eviction score (default: 0.8 = 80%)
  sizeWeight: number;               // Weight for size in eviction score (default: 0.2 = 20%)
  evictionIntervalMs: number;       // Background check interval (default: 5 min)
  evictionBatchSize: number;        // Max CoValues to evict per batch (default: 100)
  maxEvictionCandidates: number;    // Max candidates to process per eviction (default: 1000)
}

class StorageEvictionManager {
  private config: StorageEvictionConfig;
  private storage: StorageAPI;
  private inMemoryCoValues: Map<RawCoID, CoValueCore>;  // Reference to LocalNode.coValues
  private unsyncedTracker: UnsyncedCoValuesTracker;     // Reference to in-memory tracker
  private interval: ReturnType<typeof setInterval> | undefined;
  private evictionInProgress: boolean = false;          // Mutex to prevent concurrent eviction
  
  constructor(
    storage: StorageAPI,
    inMemoryCoValues: Map<RawCoID, CoValueCore>,
    unsyncedTracker: UnsyncedCoValuesTracker,
    config: Partial<StorageEvictionConfig>
  );
  
  // Start background eviction checks
  start(): void;
  
  // Stop background eviction
  stop(): void;
  
  // Check if a write of given size can proceed, evict if necessary
  // Throws StorageFullError if eviction cannot free enough space
  ensureSpaceForWrite(bytesToWrite: number): Promise<void>;
  
  // Get current storage size
  getCurrentStorageSize(): Promise<number>;
  
  // Trigger immediate eviction to free at least `bytesNeeded`
  evictToFreeSpace(bytesNeeded: number): Promise<number>;
  
  // Get eviction candidates sorted by score (highest first)
  // Only returns CoValues that are NOT in memory and ARE synced
  getEvictionCandidates(): Promise<EvictionCandidate[]>;
  
  // Calculate eviction score for a CoValue (uses logarithmic formula)
  calculateEvictionScore(candidate: EvictionCandidate): number;
}

interface EvictionCandidate {
  id: RawCoID;
  lastAccessed: number;  // Unix timestamp ms (Date.now()), from GC
  sizeBytes: number;
}

// Error thrown when storage is full and eviction cannot free enough space
class StorageFullError extends Error {
  constructor(
    public readonly currentSize: number,
    public readonly maxSize: number,
    public readonly bytesNeeded: number,
    public readonly bytesFreed: number,
  ) {
    super(`Storage full: ${currentSize}/${maxSize} bytes, needed ${bytesNeeded}, freed ${bytesFreed}`);
    this.name = 'StorageFullError';
  }
}
```

### 2. Extended StorageAPI Interface

**Location:** `packages/cojson/src/storage/types.ts`

Add new methods to support eviction:

```typescript
export interface StorageAPI {
  // ... existing methods ...
  
  // Get current database size in bytes
  getStorageSize(): Promise<number> | number;
  
  // Get eviction metadata for a CoValue
  getEvictionMetadata(id: RawCoID): Promise<EvictionMetadata | undefined> | EvictionMetadata | undefined;
  
  // Update eviction metadata (lastAccessed and/or sizeBytes)
  updateEvictionMetadata(id: RawCoID, metadata: Partial<EvictionMetadata>): Promise<void> | void;
  
  // Get all eviction candidates (CoValues with metadata, excluding unsynced)
  getEvictionCandidates(excludeIds: Set<RawCoID>): Promise<EvictionCandidate[]> | EvictionCandidate[];
  
  // Delete a CoValue and all associated data (for eviction)
  // Also clears the entry from StorageKnownState.knownStates
  deleteCoValue(id: RawCoID): Promise<void> | void;
  
  // Batch delete multiple CoValues
  // Also clears entries from StorageKnownState.knownStates
  deleteCoValues(ids: RawCoID[]): Promise<void> | void;
}

interface EvictionMetadata {
  lastAccessed: number;  // Unix timestamp ms from Date.now(), same as GC's lastAccessed
  sizeBytes: number;
}
```

### 3. GarbageCollector (Updated to use Date.now())

**Location:** `packages/cojson/src/GarbageCollector.ts`

The `GarbageCollector` is updated to use `Date.now()` instead of `performance.now()`:

```typescript
export class GarbageCollector {
  // ... existing code ...

  getCurrentTime() {
    return Date.now();  // Changed from performance.now()
  }

  // trackCoValueAccess and collect remain unchanged
  // They only use relative time differences, which work with Date.now()
}
```

**Why this works:**
- GC only compares `currentTime - lastAccessed > MAX_AGE` (relative difference)
- `Date.now()` provides correct relative differences within a session
- The same `verified.lastAccessed` value can be persisted to storage for eviction scoring
- On app restart, stored `lastAccessed` is used for eviction; GC starts fresh with new accesses

**Benefits:**
1. **Simpler design** - No separate `lastAccessedEpoch` field needed
2. **Less storage overhead** - Reuse existing `lastAccessed` from CoValueCore
3. **Consistent timestamps** - Same value used for both GC and eviction

### 4. StorageKnownState Integration

**Location:** `packages/cojson/src/storage/knownState.ts`

When a CoValue is evicted, we must also clear its entry from `StorageKnownState.knownStates`. This ensures:

1. **Correct sync behavior** - The system won't think data is still in storage when it's been evicted
2. **Clean re-fetch** - When the CoValue is requested again, it will be properly loaded from server
3. **No stale waitForSync** - Pending sync requests for evicted CoValues won't hang

```typescript
// Add method to StorageKnownState class:
class StorageKnownState {
  // ... existing methods ...
  
  /**
   * Clear known state for an evicted CoValue.
   * Called when a CoValue is deleted from storage.
   */
  clearKnownState(id: string): void {
    this.knownStates.delete(id);
    
    // Also clear any pending waitForSync requests
    const requests = this.waitForSyncRequests.get(id);
    if (requests) {
      // Resolve pending requests (they'll re-fetch from server)
      for (const request of requests) {
        request.resolve();
      }
      this.waitForSyncRequests.delete(id);
    }
  }
  
  /**
   * Batch clear known states for multiple evicted CoValues.
   */
  clearKnownStates(ids: string[]): void {
    for (const id of ids) {
      this.clearKnownState(id);
    }
  }
}
```

**Usage in StorageApiSync/StorageApiAsync:**
```typescript
deleteCoValue(id: RawCoID): void {
  // Delete from database tables
  this.dbClient.deleteCoValue(id);
  
  // Clear from knownStates cache
  this.knownStates.clearKnownState(id);
}

deleteCoValues(ids: RawCoID[]): void {
  // Delete from database tables
  this.dbClient.deleteCoValues(ids);
  
  // Clear from knownStates cache
  this.knownStates.clearKnownStates(ids);
}
```

---

## Data Models

### SQLite Schema Addition

**Location:** `packages/cojson/src/storage/sqlite/sqliteMigrations.ts`

```typescript
export const migrations: Record<number, string[]> = {
  // ... existing migrations ...
  
  5: [
    `CREATE TABLE IF NOT EXISTS covalue_eviction_metadata (
      covalue_id TEXT PRIMARY KEY,
      last_accessed INTEGER NOT NULL,
      size_bytes INTEGER NOT NULL
    );`,
    `CREATE INDEX IF NOT EXISTS idx_eviction_last_accessed 
     ON covalue_eviction_metadata(last_accessed);`,
    `CREATE INDEX IF NOT EXISTS idx_eviction_size 
     ON covalue_eviction_metadata(size_bytes);`,
  ],
};
```

### IndexedDB Schema Addition

**Location:** `packages/cojson-storage-indexeddb/src/idbNode.ts`

```typescript
// In onupgradeneeded, add version check:
if (ev.oldVersion <= 5) {
  const evictionMetadata = db.createObjectStore("evictionMetadata", {
    keyPath: "coValueId",
  });
  evictionMetadata.createIndex("byLastAccessed", "lastAccessed");
  evictionMetadata.createIndex("bySizeBytes", "sizeBytes");
}
```

---

## Algorithms

### 1. Storage Size Calculation

**SQLite:**
```typescript
function getStorageSize(db: SQLiteDatabaseDriver): number {
  const result = db.get<{ size_bytes: number }>(
    "SELECT (SELECT page_count FROM pragma_page_count) * (SELECT page_size FROM pragma_page_size) as size_bytes"
  );
  return result?.size_bytes ?? 0;
}
```

**SQLite free-space estimation (for eviction scheduling):**
```typescript
function getFreeSpaceBytes(db: SQLiteDatabaseDriver): number {
  const result = db.get<{
    page_size: number;
    freelist_count: number;
  }>(
    "SELECT (SELECT page_size FROM pragma_page_size) as page_size, (SELECT freelist_count FROM pragma_freelist_count) as freelist_count"
  );
  if (!result) return 0;
  return result.page_size * result.freelist_count;
}
```

**SQLite hard-limit enforcement:**
```typescript
function setMaxPageCount(db: SQLiteDatabaseDriver, maxStorageBytes: number) {
  const pageSize = db.get<{ page_size: number }>(
    "SELECT (SELECT page_size FROM pragma_page_size) as page_size"
  )?.page_size ?? 4096;
  const maxPages = Math.max(1, Math.floor(maxStorageBytes / pageSize));
  db.exec(`PRAGMA max_page_count = ${maxPages}`);
}
```

**IndexedDB:**
```typescript
async function getStorageSize(): Promise<number> {
  const estimate = await navigator.storage.estimate();
  
  // Try to get IndexedDB-specific usage if available (Chrome/Chromium only)
  // Falls back to total origin usage (includes Cache API, etc.)
  const usageDetails = (estimate as { usageDetails?: { indexedDB?: number } }).usageDetails;
  
  return usageDetails?.indexedDB ?? estimate.usage ?? 0;
}
```

**Note:** `usageDetails.indexedDB` is more accurate but only available in Chromium browsers. Safari and Firefox don't support it, so we fall back to `estimate.usage` which includes all origin storage (IndexedDB, Cache API, etc.). This means the limit may be less precise on non-Chromium browsers.

### 2. Eviction Score Calculation (Logarithmic Approach)

**Why Logarithmic Scoring?**

We use logarithmic scaling instead of normalization for several important reasons:

1. **No database queries required** - Normalization requires computing MIN/MAX across all candidates, which means either:
   - Iterating through all CoValues (expensive for large databases)
   - Running SQL aggregation queries (adds latency before each eviction decision)

2. **Natural scale compression** - Logarithms compress both age (milliseconds) and size (bytes) into comparable ranges:
   - Age: 1 minute (4.8) → 1 week (8.8) - range of ~4
   - Size: 1 KB (3.0) → 1 GB (9.0) - range of ~6
   
3. **Stable weights** - With normalization, the effective weight changes based on the data distribution. With log scaling, 80% age weight always means 80%.

4. **Efficient computation** - Each score is computed independently, enabling parallel processing and early termination.

```typescript
function calculateEvictionScore(
  candidate: EvictionCandidate,
  ageWeight: number = 0.8,   // 80% weight for age (recency)
  sizeWeight: number = 0.2,  // 20% weight for size
): number {
  // lastAccessed is a Unix timestamp from Date.now() (from GC)
  const ageMs = Date.now() - candidate.lastAccessed;
  
  // Use log10 to compress values into comparable ranges:
  // - log10(1 day in ms) ≈ 7.9
  // - log10(1 MB) ≈ 6.0
  // This puts both metrics in roughly the same scale (3-9)
  const ageScore = Math.log10(Math.max(ageMs, 1));
  const sizeScore = Math.log10(Math.max(candidate.sizeBytes, 1));
  
  // Weighted sum - higher score = evict first
  return (ageWeight * ageScore) + (sizeWeight * sizeScore);
}
```

**Logarithmic Scale Reference:**

| Value | Raw | log10 |
|-------|-----|-------|
| 1 minute | 60,000 ms | 4.8 |
| 1 hour | 3,600,000 ms | 6.6 |
| 1 day | 86,400,000 ms | 7.9 |
| 1 week | 604,800,000 ms | 8.8 |
| 1 KB | 1,024 bytes | 3.0 |
| 1 MB | 1,048,576 bytes | 6.0 |
| 100 MB | 104,857,600 bytes | 8.0 |
| 1 GB | 1,073,741,824 bytes | 9.0 |

**Example with default weights (0.8 age, 0.2 size):**

| CoValue | Age | Size | Age Score | Size Score | Total |
|---------|-----|------|-----------|------------|-------|
| A | 2 days | 10 MB | 0.8 × 8.2 = 6.6 | 0.2 × 7.0 = 1.4 | **8.0** |
| B | 1 day | 100 MB | 0.8 × 7.9 = 6.3 | 0.2 × 8.0 = 1.6 | **7.9** |
| C | 1 hour | 1 GB | 0.8 × 6.6 = 5.3 | 0.2 × 9.0 = 1.8 | **7.1** |

→ **A is evicted first** (score 8.0) - age dominates with 80% weight
→ Large but recent CoValues (C) are preserved longer

### 3. Eviction Candidate Selection

The system uses strict criteria to determine which CoValues can be safely evicted:

```
┌─────────────────────────────────────────────────────────────────────┐
│                     Eviction Eligibility                             │
│                                                                      │
│  EVICTABLE: NOT in memory AND synced                                │
│  - Data exists in storage only (not actively used)                   │
│  - Data has been synced to server (can be re-fetched if needed)     │
│  - Safe to delete from local storage                                │
│                                                                      │
│  PROTECTED (NEVER evict):                                           │
│  - IN memory: Would break incremental storage writes                │
│  - Unsynced: Data would be LOST if not on server                    │
└─────────────────────────────────────────────────────────────────────┘
```

**Why we don't evict in-memory CoValues:**

Evicting storage for a CoValue that's still in memory would break the incremental storage model. The storage layer assumes it can append transactions to existing sessions. If we delete storage while the CoValue is in memory:
1. Next store would try to find existing session → not found
2. Would create a new session starting from current index
3. Would lose all transaction history before that point

This would cause data corruption when the CoValue is later reloaded from storage.

**Account/Profile protection note:**
Account and profile CoValues are group CoValues and are not garbage-collected by default. Because they remain loaded in memory unless `garbageCollectGroups` is explicitly enabled, they are naturally excluded by the "in-memory" protection rule, so no extra eviction rule is required.

```typescript
async function getEvictionCandidates(
  storage: StorageAPI,
  inMemoryCoValues: Map<RawCoID, CoValueCore>,
  unsyncedTracker: UnsyncedCoValuesTracker,
): Promise<EvictionCandidate[]> {
  // Get unsynced IDs from in-memory tracker (authoritative source)
  const unsyncedIds = new Set<RawCoID>(unsyncedTracker.getAll());
  
  // Get in-memory IDs (with loaded state)
  const inMemoryIds = new Set<RawCoID>();
  for (const [id, core] of inMemoryCoValues) {
    if (core.loadingState !== "unknown") {
      inMemoryIds.add(id);
    }
  }
  
  // Combine all protected IDs
  const protectedIds = new Set<RawCoID>([...unsyncedIds, ...inMemoryIds]);
  
  // Get candidates from storage, excluding all protected IDs
  const candidates = await storage.getEvictionCandidates(protectedIds);
  
  // Sort by eviction score (highest first = evict first)
  candidates.sort((a, b) => 
    calculateEvictionScore(b) - calculateEvictionScore(a)
  );
  
  return candidates;
}
```

### 4. Size Tracking on Store

```typescript
// Factor to account for JSON overhead (property names, quotes, brackets)
// when estimating transaction sizes from string field lengths
const JSON_OVERHEAD_FACTOR = 1.3;

function calculateTransactionSize(tx: Transaction): number {
  // Estimate size without JSON.stringify for performance
  // tx.changes and tx.madeAt are strings, use their lengths directly
  const changesLen = tx.changes?.length ?? 0;
  const madeAtLen = tx.madeAt?.length ?? 0;
  return Math.ceil((changesLen + madeAtLen) * JSON_OVERHEAD_FACTOR);
}

function updateSizeOnStore(
  storage: StorageAPI,
  id: RawCoID,
  newTransactions: Transaction[],
): void {
  const currentMetadata = storage.getEvictionMetadata(id);
  const addedSize = newTransactions.reduce(
    (sum, tx) => sum + calculateTransactionSize(tx), 
    0
  );
  
  // Get lastAccessed from the CoValue's verified state (set by GC)
  const coValue = node.getCoValue(id);
  const lastAccessed = coValue.verified?.lastAccessed ?? Date.now();
  
  storage.updateEvictionMetadata(id, {
    sizeBytes: (currentMetadata?.sizeBytes ?? 0) + addedSize,
    lastAccessed,  // Persist GC's lastAccessed for eviction scoring
  });
}
```

---

## Integration Points

### 1. LocalNode Initialization

**Location:** `packages/cojson/src/localNode.ts`

```typescript
class LocalNode {
  garbageCollector: GarbageCollector | undefined = undefined;
  storageEvictionManager: StorageEvictionManager | undefined = undefined;  // NEW
  
  // GarbageCollector uses Date.now() for lastAccessed (see GarbageCollector section)
  enableGarbageCollector(opts?: { garbageCollectGroups?: boolean }) {
    if (this.garbageCollector) {
      return;
    }

    this.garbageCollector = new GarbageCollector(
      this.coValues,
      opts?.garbageCollectGroups ?? false,
    );
  }

  setStorage(storage: StorageAPI, evictionConfig?: Partial<StorageEvictionConfig>) {
    this.storage = storage;
    this.syncManager.setStorage(storage);
    
    // NEW: Initialize eviction manager if limits are configured
    if (evictionConfig?.maxStorageBytes && evictionConfig.maxStorageBytes !== Infinity) {
      this.storageEvictionManager = new StorageEvictionManager(
        storage,
        this.coValues,
        this.syncManager.unsyncedTracker,  // Pass the in-memory tracker
        evictionConfig,
      );
      this.storageEvictionManager.start();
    }
  }

  async gracefulShutdown(): Promise<unknown> {
    this.garbageCollector?.stop();
    this.storageEvictionManager?.stop();  // NEW
    await this.syncManager.gracefulShutdown();
    return this.storage?.close();
  }
}
```

### 2. Store Operation with Limit Check

**Location:** `packages/cojson/src/storage/storageSync.ts` and `storageAsync.ts`

#### Race Condition Prevention

A naive implementation could have a race condition between space check and store:
```
Thread 1: ensureSpaceForWrite(100KB) ✓  → [gap] → store(100KB)
Thread 2: ensureSpaceForWrite(100KB) ✓  → [gap] → store(100KB)
// Both pass the check, but combined they exceed the limit
```

**Multi-layer protection strategy:**

1. **Sync storage** - No race condition (single-threaded, synchronous operations)
2. **Async storage** - Space check inside queue processing (already serialized)
3. **SQLite hard limit** - `PRAGMA max_page_count` as ultimate safety net

#### Synchronous Storage (no race condition)

```typescript
// StorageApiSync - synchronous, no race condition possible
store(msg: NewContentMessage, correctionCallback: CorrectionCallback) {
  // Check runs synchronously before store - no interleaving possible
  if (this.evictionManager) {
    const writeSize = this.estimateWriteSize(msg);
    this.evictionManager.ensureSpaceForWrite(writeSize);
  }
  
  return this.storeSingle(msg, correctionCallback);
}
```

#### Asynchronous Storage (queue serialization)

```typescript
// StorageApiAsync - leverage existing storeQueue for serialization
async store(msg: NewContentMessage, correctionCallback: CorrectionCallback) {
  // Push to queue - processed one at a time
  this.storeQueue.push(msg, correctionCallback);

  this.storeQueue.processQueue(async (data, correctionCallback) => {
    // Space check happens INSIDE queue processing
    // This ensures no concurrent stores between check and write
    if (this.evictionManager) {
      const writeSize = this.estimateWriteSize(data);
      await this.evictionManager.ensureSpaceForWrite(writeSize);
    }
    
    return this.storeSingle(data, correctionCallback);
  });
}
```

#### Shared Helper

```typescript
private estimateWriteSize(msg: NewContentMessage): number {
  let size = 0;
  
  // Header size (only for new CoValues)
  // Header has fixed structure, estimate ~200 bytes
  if (msg.header) {
    size += 200;
  }
  
  // Transaction sizes - avoid JSON.stringify for performance
  // tx.changes and tx.madeAt are strings, use their lengths directly
  for (const sessionData of Object.values(msg.new)) {
    for (const tx of sessionData.newTransactions) {
      const changesLen = tx.changes?.length ?? 0;
      const metaLen = tx.madeAt?.length ?? 0;  // madeAt is a timestamp string
      size += Math.ceil((changesLen + metaLen) * JSON_OVERHEAD_FACTOR);
    }
  }
  
  return size;
}
```

#### Protection Layers Summary

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                     MULTI-LAYER PROTECTION                                   │
└─────────────────────────────────────────────────────────────────────────────┘

  Layer 1: Soft Check (ensureSpaceForWrite)
  ├─ Sync storage: runs synchronously, no race possible
  └─ Async storage: runs inside serialized queue, no race possible

  Layer 2: SQLite Hard Limit (PRAGMA max_page_count)
  ├─ True hard limit enforced by SQLite engine
  ├─ If write would exceed, SQLite returns SQLITE_FULL error
  └─ Storage layer catches error, triggers eviction, retries once

  Layer 3: IndexedDB Quota
  ├─ Browser-enforced quota per origin
  ├─ QuotaExceededError caught and triggers eviction
  └─ Less precise than SQLite (shared across origin)

  Result: No race condition can cause unbounded growth
```

### 3. Load Operation with Metadata Update

**Location:** `packages/cojson/src/storage/storageSync.ts` and `storageAsync.ts`

```typescript
// In loadCoValue(), update lastAccessed to current time:

loadCoValue(
  id: string,
  callback: (data: NewContentMessage) => void,
  done?: (found: boolean) => void,
) {
  const coValueRow = this.dbClient.getCoValue(id);

  if (!coValueRow) {
    done?.(false);
    return;
  }

  // ... existing load logic ...

  // NEW: Update lastAccessed to current time when loading
  // This prevents the CoValue from being evicted immediately after loading
  // (it would have an old timestamp from when it was last stored)
  this.dbClient.updateEvictionMetadata(id, {
    lastAccessed: Date.now(),
  });

  done?.(true);
}
```

**Why update on load:**
- When a CoValue is loaded from storage, it likely has an old `lastAccessed` timestamp
- Without updating it, the eviction system could see it as "old" and evict it immediately
- Updating to `Date.now()` ensures recently loaded CoValues are protected from eviction
- This is safe because loading indicates active use

---

## Error Handling

### SQLite hard-limit write failure (max_page_count)

When SQLite is configured with `PRAGMA max_page_count`, a write that would grow the database beyond the limit fails (e.g. `SQLITE_FULL`). In that case the storage layer should:

1. Trigger eviction to free space (using eviction metadata).
2. Retry the failed write once.
3. If it still fails, throw `StorageFullError`.

This provides **true hard-limit enforcement** at the SQLite level while still using eviction to make room opportunistically.

### Storage Full Error

When storage is full and eviction cannot free enough space, the system throws a `StorageFullError`:

```
┌─────────────────────────────────────────────────────────────────────┐
│                    Storage Pressure Handling                         │
│                                                                      │
│  1. Try to evict eligible candidates (not in memory + synced)       │
│     ↓ If not enough space freed                                     │
│  2. Throw StorageFullError                                          │
│     - Application can catch and handle (e.g., show user warning)    │
│     - Data is NOT written to storage                                │
│     - Data integrity preserved (no partial writes)                  │
└─────────────────────────────────────────────────────────────────────┘
```

```typescript
// In StorageEvictionManager.ensureSpaceForWrite():
async ensureSpaceForWrite(bytesToWrite: number): Promise<void> {
  const currentSize = await this.getCurrentStorageSize();
  const availableSpace = this.config.maxStorageBytes - currentSize;
  
  if (bytesToWrite <= availableSpace) {
    return;  // Enough space, proceed with store
  }
  
  // Try to evict (only CoValues not in memory and synced)
  const bytesNeeded = bytesToWrite - availableSpace;
  const freedBytes = await this.evictToFreeSpace(bytesNeeded);
  
  if (freedBytes >= bytesNeeded) {
    return;  // Eviction succeeded, proceed with store
  }
  
  // No more evictable candidates - throw error
  throw new StorageFullError(
    currentSize,
    this.config.maxStorageBytes,
    bytesToWrite,
    freedBytes,
  );
}
```

**Store operation handling:**
```typescript
// In StorageApiSync/StorageApiAsync.store():
async store(msg: NewContentMessage, correctionCallback: CorrectionCallback) {
  if (this.evictionManager) {
    const writeSize = this.estimateWriteSize(msg);
    // This throws StorageFullError if eviction cannot free enough space
    await this.evictionManager.ensureSpaceForWrite(writeSize);
  }
  
  // Proceed with storage write
  return this.storeSingle(msg, correctionCallback);
}
```

**Why this approach works:**
- **Eviction only targets safe candidates**: CoValues not in memory (won't break incremental writes) and synced (can be re-fetched)
- **Explicit error handling**: Application can catch `StorageFullError` and handle appropriately (e.g., show user a warning to free space)
- **Data integrity preserved**: Never evict data that could be lost, never write partial data
- **Clear failure mode**: Developers know exactly when storage is full and can react

---

## Testing Strategy

### Unit Tests

1. **StorageEvictionManager**
   - Eviction score calculation with various age/size combinations
   - Candidate filtering (excludes in-memory and unsynced)
   - Batch eviction respects batch size limits
   - `StorageFullError` thrown when no candidates available

2. **Storage Size Tracking**
   - SQLite PRAGMA returns correct size
   - Size updates on store
   - Size calculation for existing CoValues

3. **Timestamp Handling**
   - `GarbageCollector.getCurrentTime()` returns `Date.now()`
   - `lastAccessed` persists correctly across app restarts
   - Age calculation works correctly with persisted timestamps

### Integration Tests

1. **End-to-end Eviction Flow**
   - Fill storage to limit
   - Verify eviction triggers
   - Verify correct CoValues are evicted (by score)
   - Verify in-memory CoValues are NOT evicted
   - Verify unsynced CoValues are NOT evicted

2. **Limit Enforcement**
   - Write that would exceed limit triggers eviction
   - `StorageFullError` thrown when no candidates available
   - Storage works normally after candidates become available (CoValues synced/unmounted)

3. **Recovery After Eviction**
   - Evicted CoValue can be re-fetched from server
   - Re-fetched CoValue has fresh `lastAccessed` (from GC access tracking)

### Performance Tests

1. **Large Database**
   - Eviction with 10,000+ CoValues
   - PRAGMA query performance
   - Batch eviction doesn't block main thread

---

## Configuration Defaults

```typescript
const DEFAULT_EVICTION_CONFIG: StorageEvictionConfig = {
  maxStorageBytes: 5 * 1024 * 1024 * 1024,  // 5 GB
  softThresholdRatio: 0.8,                    // 80% = 4 GB (proactive eviction starts here)
  ageWeight: 0.8,                             // 80% weight for age (recency)
  sizeWeight: 0.2,                            // 20% weight for size
  evictionIntervalMs: 5 * 60 * 1000,          // 5 minutes
  evictionBatchSize: 100,                     // Max 100 CoValues per batch
  maxEvictionCandidates: 1000,                // Max candidates to process per eviction
};
```

**Config Rationale:**
- `ageWeight: 0.8` (80%) - Prioritizes recency, ensuring frequently accessed CoValues stay cached
- `sizeWeight: 0.2` (20%) - Gives a boost to larger items, making eviction more space-efficient
- `evictionBatchSize: 100` - Limits each eviction run to prevent long transactions
- `maxEvictionCandidates: 1000` - Bounds memory and processing time for candidate selection

---

## File Changes Summary

| File | Type | Changes |
|------|------|---------|
| `packages/cojson/src/storage/StorageEvictionManager.ts` | NEW | Core eviction logic |
| `packages/cojson/src/storage/types.ts` | MODIFY | Add eviction methods to StorageAPI |
| `packages/cojson/src/storage/storageSync.ts` | MODIFY | Add limit checks, metadata tracking, delete methods |
| `packages/cojson/src/storage/storageAsync.ts` | MODIFY | Add limit checks, metadata tracking, delete methods |
| `packages/cojson/src/storage/knownState.ts` | MODIFY | Add `clearKnownState` and `clearKnownStates` methods |
| `packages/cojson/src/storage/sqlite/client.ts` | MODIFY | Implement eviction methods |
| `packages/cojson/src/storage/sqlite/sqliteMigrations.ts` | MODIFY | Add migration v5 |
| `packages/cojson/src/storage/sqliteAsync/client.ts` | MODIFY | Implement eviction methods |
| `packages/cojson-storage-indexeddb/src/idbClient.ts` | MODIFY | Implement eviction methods |
| `packages/cojson-storage-indexeddb/src/idbNode.ts` | MODIFY | Add schema migration |
| `packages/cojson/src/localNode.ts` | MODIFY | Initialize eviction manager |
| `packages/cojson/src/config.ts` | MODIFY | Add eviction config |
| `packages/cojson/src/GarbageCollector.ts` | MODIFY | Change `getCurrentTime()` to use `Date.now()` |

**Note:** `GarbageCollector.ts` is modified to use `Date.now()` instead of `performance.now()`. This allows the same `verified.lastAccessed` field to be persisted and used for storage eviction scoring, eliminating the need for a separate `lastAccessedEpoch` field.
