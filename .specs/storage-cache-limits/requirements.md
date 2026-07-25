# Requirements: Storage Cache Limits (MVP)

## Introduction

This feature implements a simple storage size limit for local SQLite databases. The storage acts as a **cache** for network data - when the limit is reached, new CoValues simply aren't persisted to storage. Since all data can be re-fetched from the network, this "best effort" caching approach is acceptable for the initial implementation.

This is a simplified MVP that avoids the complexity of a full eviction system. A more sophisticated eviction-based approach can be implemented later if needed.

## User Stories

### US-1: Configure Storage Limit

**As a** developer integrating Jazz into an application  
**I want to** configure a maximum storage size for the local SQLite database  
**So that** my application doesn't consume unbounded disk space on user devices

**Acceptance Criteria:**
- WHEN a `maxStorageBytes` configuration option is provided
- THEN SQLite's `max_page_count` pragma is set to enforce this limit
- AND the limit is calculated as `maxStorageBytes / page_size`

### US-2: Graceful Handling When Storage Full

**As a** user of a Jazz application  
**I want** the application to continue working when local storage is full  
**So that** I can still use the app without errors

**Acceptance Criteria:**
- WHEN a store operation fails due to SQLITE_FULL error
- THEN the error is caught and logged (not thrown to application)
- AND the CoValue remains in memory and synced to server
- AND subsequent load operations can re-fetch from network
- AND the application continues functioning normally

### US-3: Storage Works as Network Cache

**As a** developer  
**I want** storage to act as an optional cache layer  
**So that** network fetches are avoided for recently accessed data

**Acceptance Criteria:**
- WHEN a CoValue is loaded and storage has space
- THEN the CoValue is persisted to storage for future access
- WHEN storage is full
- THEN new CoValues are not persisted but remain functional via network
- AND previously cached CoValues remain accessible from storage

### US-4: Handle Browser Storage Quota (IndexedDB)

**As a** developer using Jazz in a web application  
**I want** IndexedDB quota errors to be handled gracefully  
**So that** my web app continues working when browser storage is full

**Acceptance Criteria:**
- WHEN an IndexedDB operation fails due to `QuotaExceededError`
- THEN the error is caught and logged (not thrown to application)
- AND the CoValue remains in memory and synced to server
- AND the application continues functioning normally

## Out of Scope (Future Work)

- Automatic eviction of old/unused CoValues
- LRU or size-based eviction scoring
- Background cleanup processes
- Custom storage limits for IndexedDB (browser controls quota)

## Technical Notes

### SQLite
- SQLite's `PRAGMA max_page_count` provides a true hard limit at the database engine level
- SQLITE_FULL error code (13) indicates the limit has been reached
- Limit is configurable via `maxStorageBytes` option

### IndexedDB
- Browser enforces quota per origin (not configurable by app)
- `QuotaExceededError` (DOMException) indicates quota exceeded
- Quota varies by browser: Chrome ~80% disk, Firefox ~50% disk, Safari ~1GB

### General
- This approach requires zero additional tables or metadata tracking
- The existing sync infrastructure ensures data integrity (unsynced data is protected)
- Both storage types use the same graceful degradation pattern: catch error → log → skip write
