import * as opSQLite from "@op-engineering/op-sqlite";
import {
  ANDROID_DATABASE_PATH,
  IOS_LIBRARY_PATH,
} from "@op-engineering/op-sqlite";
import { Platform } from "react-native";

type OPSQLiteDB = ReturnType<typeof opSQLite.open>;

import { type SQLiteDatabaseDriverAsync } from "jazz-tools/react-native-core";

export class OPSQLiteAdapter implements SQLiteDatabaseDriverAsync {
  private static adapterByDbName = new Map<string, OPSQLiteAdapter>();
  private db: OPSQLiteDB | opSQLite.Transaction | null = null;
  private initializing: Promise<OPSQLiteDB> | null = null;
  private dbName: string;

  static withDB(db: OPSQLiteDB | opSQLite.Transaction): OPSQLiteAdapter {
    const adapter = new OPSQLiteAdapter();
    adapter.db = db;
    return adapter;
  }

  /**
   * Returns a shared adapter instance for the given database name.
   * Multiple providers in the same runtime reuse the same adapter.
   */
  static getInstance(dbName: string = "jazz-storage"): OPSQLiteAdapter {
    const existing = OPSQLiteAdapter.adapterByDbName.get(dbName);
    if (existing) {
      return existing;
    }

    const adapter = new OPSQLiteAdapter(dbName);
    OPSQLiteAdapter.adapterByDbName.set(dbName, adapter);
    return adapter;
  }

  public constructor(dbName: string = "jazz-storage") {
    this.dbName = dbName;
  }

  public async initialize(): Promise<void> {
    if (this.db) {
      return;
    }

    if (!this.initializing) {
      this.initializing = (async () => {
        const dbPath =
          Platform.OS === "ios" ? IOS_LIBRARY_PATH : ANDROID_DATABASE_PATH;
        const db = opSQLite.open({
          name: this.dbName,
          location: dbPath,
        });
        await db.execute("PRAGMA journal_mode=WAL");
        return db;
      })();
    }

    try {
      this.db = await this.initializing;
    } finally {
      this.initializing = null;
    }
  }

  /**
   * Reads go through op-sqlite's synchronous JSI path where it is available.
   *
   * op-sqlite's native thread pool is hardcoded to a single thread
   * (`cpp/OPThreadPool.cpp`), so async reads gain no parallelism — they just
   * queue behind one another, and each one pays for a thread hop plus a promise
   * round-trip. On a cold covalue-load storm that overhead dominates: reads are
   * ~0.2ms of actual work wrapped in ~0.5ms of dispatch.
   *
   * Transaction-scoped adapters (`withDB`) get an op-sqlite `Transaction`, which
   * exposes neither `transaction` nor `executeSync`, so their reads stay on the
   * async path and remain ordered with the transaction's own writes.
   */
  private read(sql: string, params?: unknown[]) {
    const db = this.db!;

    if ("transaction" in db && "executeSync" in db) {
      return db.executeSync(sql, params as any[]);
    }

    return db.execute(sql, params as any[]);
  }

  public async query<T>(sql: string, params?: unknown[]): Promise<T[]> {
    if (!this.db) {
      throw new Error("Database not initialized");
    }

    const result = await this.read(sql, params);

    return result.rows as T[];
  }

  public async get<T>(sql: string, params?: unknown[]): Promise<T | undefined> {
    if (!this.db) {
      throw new Error("Database not initialized");
    }

    const result = await this.read(sql, params);

    return result.rows[0] as T | undefined;
  }

  public async run(sql: string, params?: unknown[]) {
    if (!this.db) {
      throw new Error("Database not initialized");
    }

    "executeRaw" in this.db
      ? await this.db.executeRaw(sql, params as any[])
      : await this.db.execute(sql, params as any[]);
  }

  public async transaction(callback: (tx: OPSQLiteAdapter) => unknown) {
    if (!this.db) {
      throw new Error("Database not initialized");
    }
    if (!("transaction" in this.db)) {
      throw new Error("Cannot perform nested transactions");
    }

    await this.db.transaction(async (tx) => {
      try {
        await callback(OPSQLiteAdapter.withDB(tx));
        await tx.commit();
      } catch (error) {
        await tx.rollback();
        throw error;
      }
    });
  }

  public async closeDb(): Promise<void> {
    // Keeping the database open and reusing the same connection over multiple ctx instances.
  }
}
