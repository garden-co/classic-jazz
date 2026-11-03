# Design: Storage Cache Limits (MVP)

## Overview

This design implements a simple storage size limit using SQLite's built-in `PRAGMA max_page_count`. When the limit is reached, new writes silently fail and the CoValue continues to work via network sync. No eviction logic is needed - storage acts purely as a cache.

### Key Design Principles

1. **Minimal code changes** - Leverage SQLite's built-in limit enforcement
2. **Graceful degradation** - App continues working when storage is full
3. **No eviction** - Once full, new data just isn't cached locally
4. **Network as source of truth** - Storage is optional, network has all data

---

## Architecture

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                              LocalNode                                       │
│                                                                              │
│  ┌─────────────────────────────────────────────────────────────────────┐    │
│  │                         SyncManager                                   │    │
│  │  - Syncs CoValues to/from server                                     │    │
│  │  - Data always available via network                                 │    │
│  └─────────────────────────────────────────────────────────────────────┘    │
│                                    │                                         │
│                                    ▼                                         │
│  ┌─────────────────────────────────────────────────────────────────────┐    │
│  │                         StorageAPI                                    │    │
│  │  ┌─────────────────────────────────────────────────────────────┐    │    │
│  │  │  SQLite with max_page_count                                  │    │    │
│  │  │  - Hard limit enforced by SQLite engine                      │    │    │
│  │  │  - SQLITE_FULL error when limit reached                      │    │    │
│  │  │  - Error caught → write skipped silently                     │    │    │
│  │  └─────────────────────────────────────────────────────────────┘    │    │
│  └─────────────────────────────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────────────────────────────┘

STORAGE BEHAVIOR:

  Space Available          │  Storage Full (SQLITE_FULL)
  ─────────────────────────┼──────────────────────────────
  store() → saves to DB    │  store() → logs, skips save
  load() → reads from DB   │  load() → miss, fetch from network
  ✓ Acts as cache          │  ✓ App continues working
```

---

## Flow Diagrams

### 1. Store Operation Flow

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                           STORE OPERATION FLOW                               │
└─────────────────────────────────────────────────────────────────────────────┘

  store(msg) called
        │
        ▼
┌───────────────────┐
│ Execute SQL       │
│ INSERT/UPDATE     │
└─────────┬─────────┘
          │
          ▼
┌───────────────────┐
│ SQL succeeded?    │
└─────────┬─────────┘
          │
    ┌─────┴─────┐
   YES          NO (SQLITE_FULL or other error)
    │            │
    │            ▼
    │    ┌─────────────────────────────────────┐
    │    │ Is error SQLITE_FULL?               │
    │    └─────────────────┬───────────────────┘
    │                      │
    │                ┌─────┴─────┐
    │               YES          NO
    │                │            │
    │                ▼            ▼
    │    ┌──────────────────┐  ┌──────────────────┐
    │    │ Log warning      │  │ Re-throw error   │
    │    │ "Storage full,   │  │ (unexpected      │
    │    │  skipping cache" │  │  error)          │
    │    └────────┬─────────┘  └──────────────────┘
    │             │
    │             ▼
    │    ┌──────────────────┐
    │    │ Return success   │
    │    │ (graceful skip)  │
    │    └────────┬─────────┘
    │             │
    ▼             ▼
┌─────────────────────────────────────┐
│ CoValue remains in memory           │
│ CoValue synced to server            │
│ App continues normally              │
└─────────────────────────────────────┘
```

### 2. Initialization Flow

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                         INITIALIZATION FLOW                                  │
└─────────────────────────────────────────────────────────────────────────────┘

  createStorage({ maxStorageBytes }) called
        │
        ▼
┌───────────────────────────────────────┐
│ maxStorageBytes provided?             │
└─────────────────┬─────────────────────┘
                  │
            ┌─────┴─────┐
           YES          NO
            │            │
            ▼            ▼
┌─────────────────────┐  ┌─────────────────────┐
│ Get page_size       │  │ No limit set        │
│ (default 4096)      │  │ (unlimited growth)  │
└─────────┬───────────┘  └─────────────────────┘
          │
          ▼
┌─────────────────────────────────────┐
│ Calculate max_page_count:           │
│ pages = floor(maxStorageBytes /     │
│               page_size)            │
└─────────────────┬───────────────────┘
                  │
                  ▼
┌─────────────────────────────────────┐
│ PRAGMA max_page_count = pages       │
└─────────────────────────────────────┘
          │
          ▼
┌─────────────────────────────────────┐
│ Storage ready with hard limit       │
└─────────────────────────────────────┘
```

---

## Implementation

### 1. Configuration

**Location:** `packages/cojson/src/storage/sqlite/client.ts` (or equivalent)

```typescript
interface SQLiteStorageConfig {
  // ... existing config ...
  
  /**
   * Maximum storage size in bytes.
   * When reached, new writes are silently skipped (storage acts as cache).
   * If not set, storage can grow unbounded.
   */
  maxStorageBytes?: number;
}
```

### 2. Setting the Limit on Initialization

```typescript
function initializeStorage(db: SQLiteDatabaseDriver, config: SQLiteStorageConfig) {
  // Run migrations...
  
  // Set storage limit if configured
  if (config.maxStorageBytes && config.maxStorageBytes !== Infinity) {
    const pageSize = db.get<{ page_size: number }>(
      "SELECT page_size FROM pragma_page_size"
    )?.page_size ?? 4096;
    
    const maxPages = Math.max(1, Math.floor(config.maxStorageBytes / pageSize));
    
    db.exec(`PRAGMA max_page_count = ${maxPages}`);
    
    logger.info("Storage limit configured", {
      maxStorageBytes: config.maxStorageBytes,
      pageSize,
      maxPages,
    });
  }
}
```

### 3. Handling Storage Full Errors

#### Current Codebase Analysis

**SQLite behavior:**
- `BetterSqliteDriver.transaction()` calls `this.db.transaction(callback)()` which throws on SQLITE_FULL
- Errors propagate up to `storeSingle()` which has NO try-catch currently

**IndexedDB behavior (BUG):**
```typescript
// Current IDBClient.transaction() - SILENTLY SWALLOWS ERRORS!
async transaction(operationsCallback, storeNames?) {
  const tx = new CoJsonIDBTransaction(this.db, storeNames);
  try {
    await operationsCallback(new IDBTransaction(tx));
    tx.commit();
  } catch (error) {
    tx.rollback();
    // ERROR NOT RE-THROWN - caller doesn't know about failure!
  }
}
```

**Partial writes risk:**
`storeSingle()` processes multiple sessions in a loop, each with its own transaction:
```typescript
for (const sessionID of Object.keys(msg.new)) {
  this.dbClient.transaction((tx) => {  // Each session = separate transaction
    // ... store session data ...
  });
}
```
If one fails, earlier sessions may have committed.

---

#### Solution: Two-Part Fix

**Part 1: Fix IndexedDB to propagate errors**

**Location:** `packages/cojson-storage-indexeddb/src/idbClient.ts`

```typescript
async transaction(
  operationsCallback: (tx: DBTransactionInterfaceAsync) => Promise<unknown>,
  storeNames?: StoreName[],
) {
  const tx = new CoJsonIDBTransaction(this.db, storeNames);

  try {
    await operationsCallback(new IDBTransaction(tx));
    tx.commit();
  } catch (error) {
    tx.rollback();
    throw error;  // RE-THROW so caller knows about failure
  }
}
```

**Part 2: Add storageFull flag in StorageApi classes**

When storage full is detected, disable storage for the remainder of the session:

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                     STORAGE FULL HANDLING STRATEGY                           │
└─────────────────────────────────────────────────────────────────────────────┘

  Store A → Success
  Store B → SQLITE_FULL or QuotaExceededError!
        │
        ▼
  ┌─────────────────────────────────┐
  │ 1. Catch error in storeSingle   │
  │ 2. Log warning                  │
  │ 3. Set storageFull = true       │
  │ 4. Return true (graceful skip)  │
  └─────────────────────────────────┘
        │
        ▼
  All subsequent stores:
  ┌─────────────────────────────────┐
  │ if (storageFull) {              │
  │   return true; // Skip storage  │
  │ }                               │
  └─────────────────────────────────┘
        │
        ▼
  App continues via network sync
  On restart: storageFull resets, storage may have space
```

**Location:** `packages/cojson/src/storage/storageSync.ts`

```typescript
export class StorageApiSync implements StorageAPI {
  // ... existing fields ...
  
  /** Set to true when storage is full. Disables further writes until restart. */
  private storageFull = false;

  store(msg: NewContentMessage, correctionCallback: CorrectionCallback) {
    // Skip storage entirely if already full
    if (this.storageFull) {
      return true;
    }
    
    try {
      return this.storeSingle(msg, correctionCallback);
    } catch (error) {
      if (isStorageFullError(error)) {
        logger.warn("Storage full, disabling storage for this session", {
          coValueId: msg.id,
          error: String(error),
        });
        this.storageFull = true;
        return true;  // Graceful degradation
      }
      throw error;
    }
  }

  // storeSingle() remains unchanged - no try-catch needed here
}
```

**Location:** `packages/cojson/src/storage/storageAsync.ts`

```typescript
export class StorageApiAsync implements StorageAPI {
  // ... existing fields ...
  
  /** Set to true when storage is full. Disables further writes until restart. */
  private storageFull = false;

  async store(msg: NewContentMessage, correctionCallback: CorrectionCallback) {
    // Skip storage entirely if already full
    if (this.storageFull) {
      return true;
    }
    
    this.storeQueue.push(msg, correctionCallback);
    this.storeQueue.processQueue(async (data, correctionCallback) => {
      try {
        return await this.storeSingle(data, correctionCallback);
      } catch (error) {
        if (isStorageFullError(error)) {
          logger.warn("Storage full, disabling storage for this session", {
            coValueId: data.id,
            error: String(error),
          });
          this.storageFull = true;
          return true;  // Graceful degradation
        }
        throw error;
      }
    });
  }

  // storeSingle() remains unchanged
}
```

---

#### Why This Approach Works

1. **Catches errors at the right level** - `store()` wraps the entire operation, not individual transactions
2. **Prevents cascading failures** - Once full, all subsequent writes skip storage
3. **Self-healing** - On app restart, `storageFull` resets and storage may have space

---

#### What About Existing CoValues That Can't Store New Transactions?

**Scenario:**
```
1. CoValue A already in storage with transactions 1-10
2. Storage becomes full
3. New transactions 11-15 arrive (user edits)
4. Store attempt fails → storageFull = true
```

**State after failure:**

| Location | Transactions | Notes |
|----------|--------------|-------|
| Memory | 1-15 | Complete, app works normally |
| Storage | 1-10 | Partial, stale |
| Server | 1-15 | Complete, data is safe |

**On app restart:**

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                     APP RESTART RECOVERY FLOW                                │
└─────────────────────────────────────────────────────────────────────────────┘

  1. Load from storage
     └─► knownState = { sessions: { ...: 10 } }
     └─► CoValue has transactions 1-10 only

  2. Connect to server, send knownState

  3. Server compares: "Client has 1-10, I have 1-15"
     └─► Server sends transactions 11-15

  4. CoValue is complete again (1-15)
     └─► If storage has space: new transactions stored
     └─► If still full: transactions stay in memory only
```

**Why this is acceptable:**

1. **No data loss** - Server always has complete data (sync happens before storage)
2. **Automatic recovery** - Sync protocol handles the gap
3. **Storage is a cache** - Not the source of truth, just speeds up app startup
4. **Graceful degradation** - App works, just slower on restart (needs network)

**KnownState cache inconsistency:**

If failure happens mid-`storeSingle()` (between session transactions):
- Some sessions stored, some not
- In-memory `knownState` might not match storage

This is acceptable because:
- With `storageFull = true`, no more stores attempted
- On restart, `knownState` is rebuilt from storage (correct state)
- Sync with server fills in any gaps

---

**What about streaming (loading)?**

Streaming in Jazz is a **read** operation (loading large content from storage in chunks). It's unaffected by storage full errors because:
- Reads don't trigger `SQLITE_FULL` or `QuotaExceededError`
- Already-stored data remains accessible
- Only new writes are skipped

### 4. SQLite Driver Specifics

Different SQLite drivers report the error differently:

| Driver | Error Detection |
|--------|-----------------|
| better-sqlite3 | `error.code === 'SQLITE_FULL'` |
| sql.js | `error.message.includes('database or disk is full')` |
| wa-sqlite | `error.message.includes('SQLITE_FULL')` |
| D1 (Cloudflare) | TBD - may need testing |

```typescript
// SQLite-specific error detection
function isSQLiteFullError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  
  const message = error.message.toLowerCase();
  const code = (error as any).code;
  
  return (
    code === "SQLITE_FULL" ||
    code === 13 ||
    message.includes("sqlite_full") ||
    message.includes("database or disk is full") ||
    message.includes("disk i/o error")  // Sometimes reported this way
  );
}
```

### 5. IndexedDB Error Handling

**Location:** `packages/cojson-storage-indexeddb/src/idbClient.ts`

IndexedDB uses browser-enforced quotas. When the quota is exceeded, a `QuotaExceededError` is thrown.

**Key differences from SQLite:**
- No configurable limit (browser controls quota)
- Error is `DOMException` with name `QuotaExceededError`
- Quota varies by browser and available disk space

```typescript
// IndexedDB-specific error detection
function isIndexedDBQuotaError(error: unknown): boolean {
  // QuotaExceededError is a DOMException
  if (error instanceof DOMException) {
    return (
      error.name === "QuotaExceededError" ||
      error.code === 22  // Legacy quota exceeded code
    );
  }
  
  // Some browsers wrap in a generic Error
  if (error instanceof Error) {
    const message = error.message.toLowerCase();
    return (
      message.includes("quota") ||
      message.includes("quotaexceedederror") ||
      message.includes("storage quota")
    );
  }
  
  return false;
}
```

**Required Fix: IDBClient.transaction() must re-throw errors**

Currently, `IDBClient.transaction()` silently swallows ALL errors. This must be fixed:

```typescript
// packages/cojson-storage-indexeddb/src/idbClient.ts

async transaction(
  operationsCallback: (tx: DBTransactionInterfaceAsync) => Promise<unknown>,
  storeNames?: StoreName[],
) {
  const tx = new CoJsonIDBTransaction(this.db, storeNames);

  try {
    await operationsCallback(new IDBTransaction(tx));
    tx.commit();
  } catch (error) {
    tx.rollback();
    throw error;  // ADD THIS LINE - re-throw so StorageApiAsync can handle it
  }
}
```

With this fix, `QuotaExceededError` will propagate to `StorageApiAsync.store()` where it's caught and handled with the `storageFull` flag (see Section 3).
```

**Browser Quota Reference:**

| Browser | Default Quota |
|---------|---------------|
| Chrome/Edge | Up to 80% of disk, max 2GB per origin |
| Firefox | Up to 50% of disk, prompts user if > 50MB |
| Safari | ~1GB, may prompt user |

**Note:** Unlike SQLite, we cannot set a custom limit for IndexedDB. The browser manages quotas automatically. Our job is just to handle the error gracefully when it occurs.

### 6. Unified Error Detection Helper

For code that needs to handle both storage types:

```typescript
/**
 * Check if an error indicates storage is full (SQLite or IndexedDB).
 * Used by storage implementations to gracefully skip writes when quota exceeded.
 */
export function isStorageFullError(error: unknown): boolean {
  return isSQLiteFullError(error) || isIndexedDBQuotaError(error);
}

function isSQLiteFullError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  
  const message = error.message.toLowerCase();
  const code = (error as any).code;
  
  return (
    code === "SQLITE_FULL" ||
    code === 13 ||
    message.includes("sqlite_full") ||
    message.includes("database or disk is full")
  );
}

function isIndexedDBQuotaError(error: unknown): boolean {
  if (error instanceof DOMException) {
    return error.name === "QuotaExceededError" || error.code === 22;
  }
  
  if (error instanceof Error) {
    return error.message.toLowerCase().includes("quota");
  }
  
  return false;
}
```
```

---

## Data Flow Examples

### Example 1: Normal Operation (Space Available)

```
User creates a new Task
        │
        ▼
┌─────────────────────────┐
│ Task stored in memory   │
│ Task synced to server   │
│ Task saved to SQLite ✓  │ ← Storage has space
└─────────────────────────┘
        │
        ▼
Next app launch: Task loaded from SQLite (fast, no network)
```

### Example 2: Storage Full

```
User creates a new Task (storage at limit)
        │
        ▼
┌─────────────────────────┐
│ Task stored in memory   │
│ Task synced to server   │
│ SQLite returns FULL     │ ← Limit reached
│ Write skipped (logged)  │
└─────────────────────────┘
        │
        ▼
Next app launch: Task loaded from server (network fetch)
```

### Example 3: Mixed State

```
Storage: 5 GB limit, 4.9 GB used

┌────────────────────────────────────────────────────────────┐
│  Cached in SQLite          │  Not Cached (fetch from net)  │
│  ─────────────────────────────────────────────────────────│
│  • Old projects (accessed)  │  • New projects (no space)   │
│  • Recent tasks            │  • Large file references     │
│  • User profile            │                              │
└────────────────────────────────────────────────────────────┘

App works normally - some data loads fast (cached), some needs network
```

---

## Configuration Defaults

```typescript
// No default limit - must be explicitly configured
// Recommended values based on platform:

const RECOMMENDED_LIMITS = {
  desktop: 5 * 1024 * 1024 * 1024,      // 5 GB
  mobile: 500 * 1024 * 1024,             // 500 MB
  embedded: 100 * 1024 * 1024,           // 100 MB
};
```

---

## Testing Strategy

### Unit Tests

1. **SQLite Limit Initialization**
   - Verify `max_page_count` is set correctly based on `maxStorageBytes`
   - Verify no pragma set when `maxStorageBytes` not configured

2. **SQLITE_FULL Handling**
   - Simulate SQLITE_FULL error
   - Verify error is caught and logged
   - Verify `storeSingle` returns `true` (graceful skip)
   - Verify app continues functioning

3. **IndexedDB QuotaExceededError Handling**
   - Simulate `QuotaExceededError` (DOMException)
   - Verify error is caught and logged
   - Verify store returns `true` (graceful skip)
   - Verify app continues functioning

4. **Error Detection**
   - Test `isSQLiteFullError` with various SQLite error formats
   - Test `isIndexedDBQuotaError` with `DOMException` and wrapped errors
   - Test `isStorageFullError` unified helper
   - Ensure non-storage-full errors are re-thrown

### Integration Tests

1. **End-to-End SQLite Cache Behavior**
   - Set a small limit (e.g., 1 MB)
   - Store CoValues until limit reached
   - Verify subsequent stores are skipped
   - Verify previously cached data still loads
   - Verify new data can be fetched from network

2. **IndexedDB Quota Handling**
   - Mock `QuotaExceededError` from IndexedDB
   - Verify error is caught and logged
   - Verify store returns success (graceful skip)
   - Verify app continues functioning

---

## File Changes Summary

| File | Type | Changes |
|------|------|---------|
| `packages/cojson/src/storage/sqlite/client.ts` | MODIFY | Add `maxStorageBytes` config, set pragma on init |
| `packages/cojson/src/storage/sqliteAsync/client.ts` | MODIFY | Add `maxStorageBytes` config, set pragma on init |
| `packages/cojson/src/storage/storageSync.ts` | MODIFY | Add `storageFull` flag, try-catch in `store()` |
| `packages/cojson/src/storage/storageAsync.ts` | MODIFY | Add `storageFull` flag, try-catch in queue callback |
| `packages/cojson-storage-indexeddb/src/idbClient.ts` | MODIFY | **Fix bug**: re-throw error after rollback in `transaction()` |
| `packages/cojson/src/storage/errors.ts` | NEW | Shared `isStorageFullError` helper (SQLite + IndexedDB) |

---

## Future Enhancements

When/if eviction becomes necessary, the full `StorageEvictionManager` design can be implemented on top of this foundation:

1. Add eviction metadata table
2. Track `lastAccessed` timestamps
3. Implement LRU scoring
4. Add background eviction

But for now, this simple "cache with hard limit" approach provides:
- ✅ Bounded storage growth (SQLite configurable, IndexedDB browser-managed)
- ✅ Graceful degradation
- ✅ Minimal code complexity
- ✅ Zero performance overhead (SQLite/browser enforces limit)
