---
"cojson-storage-indexeddb": patch
---

Recover when the browser closes the IndexedDB connection behind our back (tab suspension on iOS/Safari, storage pressure, IndexedDB backend restarts). The connection is now managed by a connection manager that listens for `close`/`versionchange` events and lazily reopens the database, and every storage operation retries once on `InvalidStateError` instead of failing forever. Fixes the cascade of "InvalidStateError: Failed to execute 'transaction' on 'IDBDatabase': The database connection is closing" errors seen in production, after which storage silently stopped persisting for the rest of the session.
