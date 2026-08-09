import { describe, expect, it, vi } from "vitest";

vi.mock("@op-engineering/op-sqlite", () => ({
  open: vi.fn(),
  ANDROID_DATABASE_PATH: "/android",
  IOS_LIBRARY_PATH: "/ios",
}));

import { OPSQLiteAdapter } from "../storage/op-sqlite-adapter.js";

/**
 * A top-level connection: has `transaction` and the synchronous JSI path.
 */
function createFakeDb() {
  return {
    execute: vi.fn().mockResolvedValue({ rows: [{ id: "async" }] }),
    executeSync: vi.fn().mockReturnValue({ rows: [{ id: "sync" }] }),
    executeRaw: vi.fn().mockResolvedValue({ rows: [] }),
    transaction: vi.fn(),
  };
}

/**
 * An op-sqlite `Transaction` exposes neither `transaction` nor `executeSync`
 * (see its `Transaction` type), so reads on a tx-scoped adapter must stay async.
 */
function createFakeTx() {
  return {
    execute: vi.fn().mockResolvedValue({ rows: [{ id: "tx" }] }),
    commit: vi.fn().mockResolvedValue({ rows: [] }),
    rollback: vi.fn().mockResolvedValue({ rows: [] }),
  };
}

describe("OPSQLiteAdapter", () => {
  describe("reads", () => {
    it("routes get() through executeSync", async () => {
      const db = createFakeDb();
      const adapter = OPSQLiteAdapter.withDB(db as any);

      expect(await adapter.get("SELECT 1", [1])).toEqual({ id: "sync" });
      expect(db.executeSync).toHaveBeenCalledWith("SELECT 1", [1]);
      expect(db.execute).not.toHaveBeenCalled();
    });

    it("routes query() through executeSync", async () => {
      const db = createFakeDb();
      const adapter = OPSQLiteAdapter.withDB(db as any);

      expect(await adapter.query("SELECT 1")).toEqual([{ id: "sync" }]);
      expect(db.executeSync).toHaveBeenCalled();
      expect(db.execute).not.toHaveBeenCalled();
    });

    it("falls back to async execute when executeSync is unavailable", async () => {
      // The op-sqlite peer is "*", so older versions without the sync JSI path
      // must keep working rather than throwing on a missing method.
      const db: any = createFakeDb();
      delete db.executeSync;
      const adapter = OPSQLiteAdapter.withDB(db);

      expect(await adapter.get("SELECT 1")).toEqual({ id: "async" });
      expect(db.execute).toHaveBeenCalled();
    });

    it("keeps transaction-scoped reads on the async path", async () => {
      // A sync read would bypass the transaction's ordering on the connection.
      const tx = createFakeTx();
      const adapter = OPSQLiteAdapter.withDB(tx as any);

      expect(await adapter.get("SELECT 1")).toEqual({ id: "tx" });
      expect(tx.execute).toHaveBeenCalled();
    });
  });

  describe("writes", () => {
    it("keeps run() on the async path", async () => {
      const db = createFakeDb();
      const adapter = OPSQLiteAdapter.withDB(db as any);

      await adapter.run("INSERT INTO t VALUES (?)", [1]);

      expect(db.executeRaw).toHaveBeenCalledWith(
        "INSERT INTO t VALUES (?)",
        [1],
      );
      expect(db.executeSync).not.toHaveBeenCalled();
    });
  });

  describe("getInstance", () => {
    it("returns the same instance for the same database name", () => {
      expect(OPSQLiteAdapter.getInstance("db-a")).toBe(
        OPSQLiteAdapter.getInstance("db-a"),
      );
    });

    it("returns different instances for different database names", () => {
      expect(OPSQLiteAdapter.getInstance("db-a")).not.toBe(
        OPSQLiteAdapter.getInstance("db-b"),
      );
    });
  });
});
