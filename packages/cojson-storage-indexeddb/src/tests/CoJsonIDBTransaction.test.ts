import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { CoJsonIDBTransaction } from "../CoJsonIDBTransaction";
import { IDBClient } from "../idbClient";

const TEST_DB_NAME = "test-cojson-idb-transaction";

describe("CoJsonIDBTransaction", () => {
  let db: IDBDatabase;

  beforeEach(async () => {
    // Create test database
    await new Promise<void>((resolve, reject) => {
      const request = indexedDB.open(TEST_DB_NAME, 1);

      request.onerror = () => reject(request.error);

      request.onupgradeneeded = (event) => {
        const db = request.result;
        // Create test stores
        db.createObjectStore("coValues", { keyPath: "id" });
        const sessions = db.createObjectStore("sessions", { keyPath: "id" });
        sessions.createIndex("uniqueSessions", ["coValue", "sessionID"], {
          unique: true,
        });
        db.createObjectStore("transactions", { keyPath: "id" });
        db.createObjectStore("signatureAfter", { keyPath: "id" });
        const deletedCoValues = db.createObjectStore("deletedCoValues", {
          keyPath: "coValueID",
        });
        deletedCoValues.createIndex("deletedCoValuesByStatus", "status", {
          unique: false,
        });
        const unsyncedCoValues = db.createObjectStore("unsyncedCoValues", {
          keyPath: "rowID",
        });
        unsyncedCoValues.createIndex("byCoValueId", "coValueId");
        unsyncedCoValues.createIndex(
          "uniqueUnsyncedCoValues",
          ["coValueId", "peerId"],
          {
            unique: true,
          },
        );
        db.createObjectStore("storageReconciliationLocks", {
          keyPath: "key",
        });
      };

      request.onsuccess = () => {
        db = request.result;
        resolve();
      };
    });
  });

  afterEach(async () => {
    // Close and delete test database
    db.close();
    await new Promise<void>((resolve, reject) => {
      const request = indexedDB.deleteDatabase(TEST_DB_NAME);
      request.onerror = () => reject(request.error);
      request.onsuccess = () => resolve();
    });
  });

  test("handles successful write and read operations", async () => {
    const tx = new CoJsonIDBTransaction(db);

    // Write test
    await tx.handleRequest((tx) =>
      tx.getObjectStore("coValues").put({
        id: "test1",
        value: "hello",
      }),
    );

    // Read test
    const readTx = new CoJsonIDBTransaction(db);
    const result = await readTx.handleRequest((tx) =>
      tx.getObjectStore("coValues").get("test1"),
    );

    expect(result).toEqual({
      id: "test1",
      value: "hello",
    });
  });

  test("handles multiple operations in single transaction", async () => {
    const tx = new CoJsonIDBTransaction(db);

    // Multiple writes
    await Promise.all([
      tx.handleRequest((tx) =>
        tx.getObjectStore("coValues").put({
          id: "test1",
          value: "hello",
        }),
      ),
      tx.handleRequest((tx) =>
        tx.getObjectStore("coValues").put({
          id: "test2",
          value: "world",
        }),
      ),
    ]);

    // Read results
    const readTx = new CoJsonIDBTransaction(db);
    const [result1, result2] = await Promise.all([
      readTx.handleRequest((tx) => tx.getObjectStore("coValues").get("test1")),
      readTx.handleRequest((tx) => tx.getObjectStore("coValues").get("test2")),
    ]);

    expect(result1).toEqual({
      id: "test1",
      value: "hello",
    });
    expect(result2).toEqual({
      id: "test2",
      value: "world",
    });
  });

  test("handles transaction across multiple stores", async () => {
    const tx = new CoJsonIDBTransaction(db);

    await Promise.all([
      tx.handleRequest((tx) =>
        tx.getObjectStore("coValues").put({
          id: "value1",
          data: "value data",
        }),
      ),
      tx.handleRequest((tx) =>
        tx.getObjectStore("sessions").put({
          id: "session1",
          data: "session data",
        }),
      ),
    ]);

    const readTx = new CoJsonIDBTransaction(db);
    const [valueResult, sessionResult] = await Promise.all([
      readTx.handleRequest((tx) => tx.getObjectStore("coValues").get("value1")),
      readTx.handleRequest((tx) =>
        tx.getObjectStore("sessions").get("session1"),
      ),
    ]);

    expect(valueResult).toEqual({
      id: "value1",
      data: "value data",
    });
    expect(sessionResult).toEqual({
      id: "session1",
      data: "session data",
    });
  });

  test("handles failed transactions", async () => {
    const tx = new CoJsonIDBTransaction(db);

    await expect(
      tx.handleRequest((tx) =>
        tx.getObjectStore("sessions").put({
          id: 1,
          coValue: "value1",
          sessionID: "session1",
          data: "session data",
        }),
      ),
    ).resolves.toBe(1);

    expect(tx.failed).toBe(false);

    const badTx = new CoJsonIDBTransaction(db);
    await expect(
      badTx.handleRequest((tx) =>
        tx.getObjectStore("sessions").put({
          id: 2,
          coValue: "value1",
          sessionID: "session1",
          data: "session data",
        }),
      ),
    ).rejects.toThrow();

    expect(badTx.failed).toBe(true);
  });

  test("transaction with custom stores only includes specified stores", async () => {
    const tx = new CoJsonIDBTransaction(db, ["coValues", "sessions"]);

    // Should work with included stores
    await tx.handleRequest((tx) =>
      tx.getObjectStore("coValues").put({
        id: "test1",
        value: "hello",
      }),
    );

    await tx.handleRequest((tx) =>
      tx.getObjectStore("sessions").put({
        id: "session1",
        data: "session data",
      }),
    );

    // Should fail when trying to access a store not included in transaction
    await expect(
      tx.handleRequest((tx) =>
        tx.getObjectStore("transactions").put({
          id: "tx1",
          data: "tx data",
        }),
      ),
    ).rejects.toThrow(
      "Failed to execute 'objectStore' on 'IDBTransaction': The specified object store was not found.",
    );
  });

  test("if no custom stores are provided, transaction uses default stores", async () => {
    const tx = new CoJsonIDBTransaction(db);

    await tx.handleRequest((tx) =>
      tx.getObjectStore("coValues").put({
        id: "test1",
        value: "hello",
      }),
    );

    await tx.handleRequest((tx) =>
      tx.getObjectStore("sessions").put({
        id: "session1",
        data: "session data",
      }),
    );

    await tx.handleRequest((tx) =>
      tx.getObjectStore("transactions").put({
        id: "tx1",
        data: "tx data",
      }),
    );

    await tx.handleRequest((tx) =>
      tx.getObjectStore("signatureAfter").put({
        id: "sig1",
        data: "sig data",
      }),
    );

    // Should fail when trying to access unsyncedCoValues (not in default)
    await expect(
      tx.handleRequest((tx) =>
        tx.getObjectStore("unsyncedCoValues").put({
          rowID: 1,
          coValueId: "coValue1",
          peerId: "peer1",
        }),
      ),
    ).rejects.toThrow(
      "Failed to execute 'objectStore' on 'IDBTransaction': The specified object store was not found.",
    );
  });
});

describe("IDBClient", () => {
  let db: IDBDatabase;

  beforeEach(async () => {
    await new Promise<void>((resolve, reject) => {
      const request = indexedDB.open(TEST_DB_NAME, 1);

      request.onerror = () => reject(request.error);

      request.onupgradeneeded = () => {
        const db = request.result;
        const coValues = db.createObjectStore("coValues", {
          keyPath: "rowID",
          autoIncrement: true,
        });
        coValues.createIndex("coValuesById", "id", { unique: true });
        const sessions = db.createObjectStore("sessions", {
          keyPath: "rowID",
          autoIncrement: true,
        });
        sessions.createIndex("uniqueSessions", ["coValue", "sessionID"], {
          unique: true,
        });
        sessions.createIndex("sessionsByCoValue", "coValue");
        db.createObjectStore("transactions", {
          keyPath: ["ses", "idx"],
        });
        db.createObjectStore("signatureAfter", {
          keyPath: ["ses", "idx"],
        });
        const deletedCoValues = db.createObjectStore("deletedCoValues", {
          keyPath: "coValueID",
        });
        deletedCoValues.createIndex("deletedCoValuesByStatus", "status", {
          unique: false,
        });
        const unsyncedCoValues = db.createObjectStore("unsyncedCoValues", {
          keyPath: "rowID",
          autoIncrement: true,
        });
        unsyncedCoValues.createIndex("byCoValueId", "coValueId");
        unsyncedCoValues.createIndex(
          "uniqueUnsyncedCoValues",
          ["coValueId", "peerId"],
          { unique: true },
        );
        db.createObjectStore("storageReconciliationLocks", {
          keyPath: "key",
        });
      };

      request.onsuccess = () => {
        db = request.result;
        resolve();
      };
    });
  });

  afterEach(async () => {
    db.close();
    await new Promise<void>((resolve, reject) => {
      const request = indexedDB.deleteDatabase(TEST_DB_NAME);
      request.onerror = () => reject(request.error);
      request.onsuccess = () => resolve();
    });
  });

  test("close() marks the client as closed", () => {
    const client = new IDBClient(db);
    expect(client.isClosed()).toBe(false);
    client.close();
    expect(client.isClosed()).toBe(true);
  });

  test("close() is idempotent", () => {
    const client = new IDBClient(db);
    client.close();
    client.close();
    expect(client.isClosed()).toBe(true);
  });

  test("transaction() is a no-op after close", async () => {
    const client = new IDBClient(db);

    await client.transaction(
      async (tx) => {
        await tx.putUnsyncedCoValueRecord({
          coValueId: "co_zBefore" as any,
          peerId: "peer",
        });
      },
      ["unsyncedCoValues"],
    );

    client.close();

    let callbackRan = false;
    await client.transaction(async () => {
      callbackRan = true;
    });
    expect(callbackRan).toBe(false);

    const freshDb = await new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open(TEST_DB_NAME);
      req.onerror = () => reject(req.error);
      req.onsuccess = () => resolve(req.result);
    });
    const readTx = freshDb.transaction("unsyncedCoValues", "readonly");
    const all = await new Promise<any[]>((resolve) => {
      const req = readTx.objectStore("unsyncedCoValues").getAll();
      req.onsuccess = () => resolve(req.result);
    });
    freshDb.close();

    expect(all).toHaveLength(1);
    expect(all[0].coValueId).toBe("co_zBefore");
  });

  test("trackCoValuesSyncState is a no-op after close", async () => {
    const client = new IDBClient(db);
    client.close();

    await client.trackCoValuesSyncState([
      { id: "co_zTest" as any, peerId: "peer", synced: false },
    ]);

    const freshDb = await new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open(TEST_DB_NAME);
      req.onerror = () => reject(req.error);
      req.onsuccess = () => resolve(req.result);
    });
    const readTx = freshDb.transaction("unsyncedCoValues", "readonly");
    const all = await new Promise<any[]>((resolve) => {
      const req = readTx.objectStore("unsyncedCoValues").getAll();
      req.onsuccess = () => resolve(req.result);
    });
    freshDb.close();

    expect(all).toHaveLength(0);
  });
});
