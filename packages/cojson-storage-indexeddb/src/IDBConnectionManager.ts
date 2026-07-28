import { DATABASE_VERSION, openDatabase } from "./idbSchema.js";

function isDOMException(error: unknown, name: string) {
  return (error as DOMException | null)?.name === name;
}

/**
 * Owns the IDBDatabase connection and reopens it lazily after the browser
 * closes it behind our back (tab suspension on iOS/Safari, storage pressure,
 * IndexedDB backend restarts). The connection is a cache that can be
 * invalidated, never a permanent handle.
 */
export class IDBConnectionManager {
  private dbPromise: Promise<IDBDatabase> | undefined;
  private currentDb: IDBDatabase | undefined;

  constructor(private name: string) {}

  getDb(): Promise<IDBDatabase> {
    if (!this.dbPromise) {
      this.dbPromise = this.open();
    }
    return this.dbPromise;
  }

  /**
   * Runs an operation against the current connection, reopening the database
   * and retrying the operation once when the browser closed the connection
   * behind our back. A transaction on a closing connection never commits, so
   * callers must only pass operations that are safe to run again after a
   * failure that didn't commit.
   */
  async withConnection<T>(op: (db: IDBDatabase) => Promise<T>): Promise<T> {
    // Fast path: skip the promise machinery while the connection is healthy
    const db = this.currentDb ?? (await this.getDb());

    try {
      return await op(db);
    } catch (error) {
      if (!isDOMException(error, "InvalidStateError")) {
        throw error;
      }

      this.invalidate(db);
      return op(await this.getDb());
    }
  }

  private async open(): Promise<IDBDatabase> {
    try {
      const db = await openDatabase(this.name, DATABASE_VERSION).catch(
        (error) => {
          if (!isDOMException(error, "VersionError")) {
            throw error;
          }
          // A newer tab already upgraded the schema (migrations are
          // additive), so open at whatever version currently exists.
          return openDatabase(this.name);
        },
      );

      // Fired when the browser force-closes the connection; not fired on
      // an explicit db.close()
      db.onclose = () => {
        this.invalidate(db);
      };
      // Close so another tab can upgrade or delete the database instead of
      // being blocked forever; the next operation reopens
      db.onversionchange = () => {
        db.close();
        this.invalidate(db);
      };

      this.currentDb = db;
      return db;
    } catch (error) {
      this.dbPromise = undefined;
      throw error;
    }
  }

  /**
   * Drops the cached connection so the next operation reopens the database.
   * No-op if a newer connection has already replaced `db`.
   */
  private invalidate(db: IDBDatabase) {
    if (this.currentDb !== db) {
      return;
    }
    this.currentDb = undefined;
    this.dbPromise = undefined;
  }
}
