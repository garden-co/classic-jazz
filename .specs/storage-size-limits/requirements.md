# Requirements: Storage Size Limits with Intelligent Eviction

## Introduction

Jazz's storage backends (SQLite and IndexedDB) currently have no size limits - they grow indefinitely as CoValues are synced and cached locally. This can cause issues on mobile devices and browsers with limited storage, potentially leading to app crashes, degraded performance, or storage quota errors.

This feature adds configurable storage size limits with intelligent eviction of CoValues based on a hybrid strategy combining access recency (LRU) and size. Larger CoValues that haven't been accessed recently are preferred for eviction, making the eviction process more efficient. The system ensures that unsynced data is never evicted, preserving data integrity while keeping storage usage within bounds.

### Goals

- **Enforce hard storage limits** - the database must NEVER exceed the configured maximum size
- Prevent unbounded storage growth on resource-constrained devices
- Automatically evict least recently used CoValues when approaching storage limits
- Never evict unsynced data (preserving user's unpersisted changes)
- Support re-fetching evicted CoValues from server on demand
- Provide configurable limits with sensible defaults (5 GB)

### Non-Goals

- User-facing UI for storage management
- Manual control over which CoValues to evict
- Dependency-aware eviction (evicting related CoValues together)

---

## User Stories & Acceptance Criteria

### US1: Configurable Storage Size Limit

**As a** Jazz application developer  
**I want to** configure a maximum storage size for local CoValue storage  
**So that** my app doesn't consume excessive device storage

**Acceptance Criteria (EARS - Easy Approach to Requirements Syntax):**

1. **When** initializing Jazz storage, **the system shall** accept an optional `maxStorageBytes` configuration parameter.
2. **When** no `maxStorageBytes` is provided, **the system shall** use a default limit of 5 GB.
3. **When** `maxStorageBytes` is set to `0` or `Infinity`, **the system shall** disable storage limits entirely.
4. **The system shall** support storage limits for both SQLite (React Native/desktop) and IndexedDB (browser) backends.

---

### US2: Storage Size Monitoring

**As a** Jazz storage system  
**I want to** monitor current storage usage  
**So that** I can determine when eviction is necessary

**Acceptance Criteria:**

1. **For SQLite storage**, **the system shall** use `PRAGMA page_count * page_size` to determine current storage size.
2. **For IndexedDB storage**, **the system shall** use `navigator.storage.estimate()` to approximate current storage usage.
3. **The system shall** check storage size periodically (configurable interval, default 5 minutes) in the background.
4. **The system shall** check storage size before storing new content when approaching the limit.

---

### US3: Access Recency and Size Tracking

**As a** Jazz storage system  
**I want to** track when each CoValue was last accessed and its size  
**So that** I can identify eviction candidates based on recency and size

**Acceptance Criteria:**

1. **The system shall** update `GarbageCollector` to use `Date.now()` instead of `performance.now()`, allowing `verified.lastAccessed` to be persisted for storage eviction.
2. **When** a CoValue is loaded from storage, **the system shall** update its `lastAccessed` to current time to prevent immediate eviction.
3. **When** new content is stored for a CoValue, **the system shall** update both `lastAccessed` (from GC's `verified.lastAccessed`) and `sizeBytes` (incrementally adding new transaction sizes).
4. **The system shall** persist `lastAccessed` and `sizeBytes` in storage across app restarts.
5. **When** a CoValue has no recorded `lastAccessed` in storage, **the system shall** treat it as the oldest (most eligible for eviction).
6. **When** a CoValue has no recorded `sizeBytes`, **the system shall** calculate it on first access by summing header and transaction sizes.
7. **The system shall** estimate transaction size as the JSON-serialized length of the transaction data.

---

### US4: Hybrid LRU + Size-Based Eviction

**As a** Jazz storage system  
**I want to** evict CoValues based on both access recency and size  
**So that** storage is freed efficiently while respecting usage patterns

**Acceptance Criteria:**

1. **The system shall** perform proactive eviction when storage exceeds the soft threshold (80% of max by default) to maintain headroom.
2. **The system shall** perform immediate eviction when a write would exceed the hard limit (100% of max).
3. **The system shall** calculate an eviction score for each candidate combining recency and size:
   - CoValues that are older AND larger should be evicted first
   - Age (recency) should have higher weight than size by default
4. **The system shall** use a logarithmic eviction score formula: `score = (ageWeight × log10(age_ms)) + (sizeWeight × log10(size_bytes))` where:
   - `ageWeight` = weight for age factor (default 0.8 = 80%)
   - `sizeWeight` = weight for size factor (default 0.2 = 20%)
   - Logarithmic scaling ensures both age and size contribute proportionally without requiring normalization
5. **The system shall** evict CoValues in order of score (highest first).
6. **For proactive eviction**, **the system shall** continue evicting until storage size falls below the soft threshold.
7. **For immediate eviction**, **the system shall** evict enough to accommodate the incoming write.
8. **When** evicting a CoValue, **the system shall** delete all associated data: header, sessions, transactions, signatures, and metadata.
9. **The system shall** support configuring the soft threshold ratio (default 0.8).
10. **The system shall** support configuring the age weight (default 0.8) and size weight (default 0.2) factors.

---

### US5: Protection of Active and Unsynced Data

**As a** Jazz user  
**I want** my active and unsynced changes to never be evicted from storage  
**So that** I don't lose data and the app continues to work correctly

**Acceptance Criteria:**

1. **The system shall** NEVER evict CoValues that appear in the `unsynced_covalues` tracking table (data would be lost on crash).
2. **The system shall** NEVER evict CoValues that are currently loaded in memory (would break incremental storage writes).
3. **The system shall** treat the current account and profile CoValues as protected from eviction by default, since group CoValues are not garbage-collected unless `garbageCollectGroups` is explicitly enabled.
4. **The system shall** only evict CoValues that are:
   - NOT in memory (have been unmounted by GarbageCollector), AND
   - Synced to server (data can be safely re-fetched)
5. **When** no evictable CoValues remain (all are in-memory or unsynced), **the system shall** throw a `StorageFullError`.
6. **The system shall** use the in-memory `UnsyncedCoValuesTracker` as the authoritative source for sync status (not the storage table, which may have batching delays).

---

### US6: On-Demand Re-fetching of Evicted CoValues

**As a** Jazz application  
**I want to** transparently re-fetch evicted CoValues from the server  
**So that** eviction doesn't break application functionality

**Acceptance Criteria:**

1. **When** a CoValue is requested that was previously evicted, **the system shall** fetch it from the server using normal sync mechanisms.
2. **The system shall not** maintain tombstones or records of evicted CoValues (clean deletion).
3. **When** re-fetching an evicted CoValue, **the system shall** update its `lastAccessed` via `GarbageCollector.trackCoValueAccess()`.

---

### US7: Hard Storage Limit Enforcement

**As a** Jazz storage system  
**I want to** enforce the storage limit as a hard constraint  
**So that** the database size never exceeds the configured maximum

**Acceptance Criteria:**

1. **The system shall** NEVER allow the database to exceed `maxStorageBytes` under any circumstances.
2. **Before** storing any new content, **the system shall** check if the write would exceed the limit.
3. **When** a store operation would exceed the limit, **the system shall** trigger immediate eviction to make room BEFORE storing.
4. **If** immediate eviction can free sufficient space, **the system shall** evict and then proceed with the store.
5. **The system shall** only evict CoValues that are NOT in memory AND synced to server.
6. **If** no evictable CoValues remain (all are in-memory or unsynced), **the system shall** throw a `StorageFullError`.
7. **The system shall not** block the main thread during eviction operations for extended periods.
8. **When** eviction is running, **the system shall** process eviction in batches to avoid long-running transactions.

---

### US8: Database Migration

**As a** Jazz storage system  
**I want to** migrate existing databases to support eviction metadata tracking  
**So that** the feature works with existing installations

**Acceptance Criteria:**

1. **The system shall** add a new table/store for eviction metadata (access time and size) without modifying existing tables.
2. **When** opening a database without the eviction metadata table, **the system shall** create it automatically.
3. **When** accessing a CoValue without eviction metadata, **the system shall** create a record with current timestamp and calculated size.
4. **The migration shall not** require iterating through all existing CoValues (lazy migration).
5. **The system shall** calculate size for existing CoValues on-demand when they are first accessed after migration.

---

## Technical Constraints

1. **SQLite storage** uses synchronous operations (better-sqlite3, op-sqlite, expo-sqlite).
2. **IndexedDB storage** uses asynchronous operations.
3. **The storage limit is a HARD constraint** - the database must NEVER exceed `maxStorageBytes`.
4. **Eviction must not** cause data loss for unsynced CoValues under any circumstances.
5. **Eviction must not** remove CoValues that are currently loaded in memory (would break incremental storage writes).
6. **Storage size checks** should be efficient and not significantly impact performance.
7. **The feature** must work with existing `UnsyncedCoValuesTracker` infrastructure (using in-memory tracker as authoritative source).
8. **Access time tracking** must use `Date.now()` epoch timestamps (NOT `GarbageCollector`'s `performance.now()` timestamps).
9. **Store operations** must check available space BEFORE writing to ensure the limit is never exceeded.
10. **GarbageCollector** must NOT be modified - the eviction system operates independently.

---

## Out of Scope

1. Compacting/vacuuming SQLite database after eviction (SQLite handles this automatically over time)
2. Partial CoValue eviction (keeping headers, evicting only transactions)
3. Type-based eviction policies (e.g., prioritizing certain CoValue types)
4. Cross-device coordination of eviction
5. User notifications about storage usage or eviction events
