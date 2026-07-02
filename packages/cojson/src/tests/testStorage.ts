import { randomUUID } from "node:crypto";
import { unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database, { type Database as DatabaseT } from "libsql";
import { onTestFinished } from "vitest";
import { RawCoID, SessionID, StorageAPI } from "../exports";
import { SQLiteDatabaseDriver } from "../storage";
import { getSqliteStorage } from "../storage/sqlite";
import {
  SQLiteDatabaseDriverAsync,
  getSqliteStorageAsync,
} from "../storage/sqliteAsync";
import { SyncMessagesLog } from "./testUtils";
import { knownStateFromContent } from "../coValueContentMessage";

class LibSQLSqliteAsyncDriver implements SQLiteDatabaseDriverAsync {
  private readonly db: DatabaseT;

  constructor(filename: string) {
    this.db = new Database(filename, {});
  }

  async initialize() {
    await this.db.pragma("journal_mode = WAL");
  }

  async run(sql: string, params: unknown[]) {
    this.db.prepare(sql).run(params);
  }

  async query<T>(sql: string, params: unknown[]): Promise<T[]> {
    return this.db.prepare(sql).all(params) as T[];
  }

  async get<T>(sql: string, params: unknown[]): Promise<T | undefined> {
    return this.db.prepare(sql).get(params) as T | undefined;
  }

  async transaction(callback: (tx: LibSQLSqliteAsyncDriver) => unknown) {
    await this.run("BEGIN TRANSACTION", []);

    try {
      await callback(this);
      await this.run("COMMIT", []);
    } catch (error) {
      await this.run("ROLLBACK", []);
      throw error;
    }
  }

  async closeDb() {
    this.db.close();
  }
}

class LibSQLSqliteSyncDriver implements SQLiteDatabaseDriver {
  private readonly db: DatabaseT;

  constructor(filename: string) {
    this.db = new Database(filename, {});
  }

  initialize() {
    this.db.pragma("journal_mode = WAL");
  }

  run(sql: string, params: unknown[]) {
    this.db.prepare(sql).run(params);
  }

  query<T>(sql: string, params: unknown[]): T[] {
    return this.db.prepare(sql).all(params) as T[];
  }

  get<T>(sql: string, params: unknown[]): T | undefined {
    return this.db.prepare(sql).get(params) as T | undefined;
  }

  transaction(callback: () => unknown) {
    this.run("BEGIN TRANSACTION", []);

    try {
      callback();
      this.run("COMMIT", []);
    } catch (error) {
      this.run("ROLLBACK", []);
    }
  }

  closeDb() {
    this.db.close();
  }
}

/** Cleanup functions registered by createAsyncStorage/createSyncStorage; run by the runner hook (registered first so it runs last). */
const storageCleanupFns: Array<() => void | Promise<void>> = [];

function registerStorageCleanup(fn: () => void | Promise<void>): void {
  storageCleanupFns.push(fn);
}

/** Call from beforeEach so this hook is registered first and thus runs last (LIFO), after node shutdown hooks. */
export function registerStorageCleanupRunner(): void {
  // Clear cleanup functions from previous test
  storageCleanupFns.length = 0;
  onTestFinished(async () => {
    for (const fn of storageCleanupFns) {
      await fn();
    }
  });
}

function unlinkIfExists(path: string): void {
  try {
    unlinkSync(path);
  } catch (error: unknown) {
    const err = error as NodeJS.ErrnoException;
    if (err?.code !== "ENOENT") {
      console.error(error);
    }
  }
}

function deleteDb(dbPath: string): void {
  unlinkIfExists(dbPath);
  unlinkIfExists(`${dbPath}-wal`);
  unlinkIfExists(`${dbPath}-shm`);
}

export async function createAsyncStorage({
  filename,
  nodeName = "client",
  storageName = "storage",
}: {
  filename?: string;
  nodeName: string;
  storageName: string;
}) {
  const dbPath = getDbPath(filename);

  const storage = await getSqliteStorageAsync(
    new LibSQLSqliteAsyncDriver(dbPath),
  );

  registerStorageCleanup(async () => {
    await storage.close();
    deleteDb(dbPath);
  });

  trackStorageMessages(storage, nodeName, storageName);

  return storage;
}

export function createSyncStorage({
  filename,
  nodeName = "client",
  storageName = "storage",
}: {
  filename?: string;
  nodeName: string;
  storageName: string;
}) {
  const dbPath = getDbPath(filename);

  const storage = getSqliteStorage(
    new LibSQLSqliteSyncDriver(getDbPath(filename)),
  );

  registerStorageCleanup(() => {
    storage.close();
    deleteDb(dbPath);
  });

  trackStorageMessages(storage, nodeName, storageName);

  return storage;
}

export async function getAllCoValuesWaitingForDelete(
  storage: StorageAPI,
): Promise<RawCoID[]> {
  // @ts-expect-error - dbClient is private
  return storage.dbClient.getAllCoValuesWaitingForDelete();
}

export async function getCoValueStoredSessions(
  storage: StorageAPI,
  id: RawCoID,
): Promise<SessionID[]> {
  return new Promise<SessionID[]>((resolve) => {
    storage.load(
      id,
      (content) => {
        if (content.id === id) {
          resolve(
            Object.keys(knownStateFromContent(content).sessions) as SessionID[],
          );
        }
      },
      () => {},
    );
  });
}

export function getDbPath(defaultDbPath?: string) {
  return defaultDbPath ?? join(tmpdir(), `test-${randomUUID()}.db`);
}

function trackStorageMessages(
  storage: StorageAPI,
  nodeName: string,
  storageName: string,
) {
  const originalStore = storage.store;
  const originalLoad = storage.load;
  const originalLoadKnownState = storage.loadKnownState;

  storage.loadKnownState = function (id, callback) {
    SyncMessagesLog.add({
      from: nodeName,
      to: storageName,
      msg: {
        action: "lazyLoad",
        id: id as RawCoID,
      },
    });

    return originalLoadKnownState.call(storage, id, (knownState) => {
      if (knownState) {
        SyncMessagesLog.add({
          from: storageName,
          to: nodeName,
          msg: {
            action: "lazyLoadResult",
            ...knownState,
          },
        });
      } else {
        SyncMessagesLog.add({
          from: storageName,
          to: nodeName,
          msg: {
            action: "lazyLoadResult",
            id: id as RawCoID,
            header: false,
            sessions: {},
          },
        });
      }

      return callback(knownState);
    });
  };

  storage.store = function (data, correctionCallback) {
    if ("action" in data && data.action === "replaceSessionHistory") {
      return originalStore.call(storage, data, correctionCallback);
    }

    SyncMessagesLog.add({
      from: nodeName,
      to: storageName,
      msg: data,
    });

    return originalStore.call(storage, data, (correction) => {
      SyncMessagesLog.add({
        from: storageName,
        to: nodeName,
        msg: {
          action: "known",
          isCorrection: true,
          ...correction,
        },
      });

      const correctionMessages = correctionCallback(correction);

      if (correctionMessages) {
        for (const msg of correctionMessages) {
          SyncMessagesLog.add({
            from: nodeName,
            to: storageName,
            msg,
          });
        }
      }

      return correctionMessages;
    });
  };

  storage.load = function (id, callback, done) {
    SyncMessagesLog.add({
      from: nodeName,
      to: storageName,
      msg: {
        action: "load",
        id: id as RawCoID,
        sessions: {},
        header: false,
      },
    });

    return originalLoad.call(
      storage,
      id,
      (msg) => {
        SyncMessagesLog.add({
          from: storageName,
          to: nodeName,
          msg,
        });

        return callback(msg);
      },
      (found) => {
        if (!found) {
          SyncMessagesLog.add({
            from: storageName,
            to: nodeName,
            msg: {
              action: "known",
              id: id as RawCoID,
              sessions: {},
              header: false,
            },
          });
        }

        return done?.(found);
      },
    );
  };
}
