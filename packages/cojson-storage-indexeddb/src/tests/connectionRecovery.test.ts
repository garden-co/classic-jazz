import { StorageApiAsync } from "cojson";
import type { CojsonInternalTypes, RawCoID } from "cojson";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { IDBClient } from "../idbClient.js";
import { IDBConnectionManager } from "../IDBConnectionManager.js";
import { getIndexedDBStorage, internal_setDatabaseName } from "../index.js";
import { createTestNode } from "./testUtils.js";

let dbName: string;

beforeEach(() => {
  dbName = `test-${crypto.randomUUID()}`;
  internal_setDatabaseName(dbName);
});

afterEach(async () => {
  indexedDB.deleteDatabase(dbName);
});

const TEST_HEADER = {
  type: "comap",
  ruleset: { type: "unsafeAllowAll" },
  meta: null,
} as unknown as CojsonInternalTypes.CoValueHeader;

describe("IDBConnectionManager", () => {
  let manager: IDBConnectionManager;

  beforeEach(() => {
    manager = new IDBConnectionManager(dbName);
  });

  afterEach(async () => {
    (await manager.getDb()).close();
  });

  test("returns the same connection while it stays healthy", async () => {
    const db1 = await manager.getDb();
    const db2 = await manager.getDb();

    expect(db2).toBe(db1);
  });

  test("reopens the connection after the browser fires close", async () => {
    const db1 = await manager.getDb();

    // The browser dispatches this event when it force-closes the connection
    db1.dispatchEvent(new Event("close"));

    const db2 = await manager.getDb();
    expect(db2).not.toBe(db1);

    db1.close();
  });

  test("closes and reopens the connection on versionchange", async () => {
    const db1 = await manager.getDb();

    db1.dispatchEvent(new Event("versionchange"));

    const db2 = await manager.getDb();
    expect(db2).not.toBe(db1);
  });
});

describe("IDBClient connection recovery", () => {
  let manager: IDBConnectionManager;
  let client: IDBClient;

  beforeEach(() => {
    manager = new IDBConnectionManager(dbName);
    client = new IDBClient(manager);
  });

  afterEach(async () => {
    (await manager.getDb()).close();
  });

  test("reads succeed after the connection was closed", async () => {
    const id = "co_ztest1" as RawCoID;
    await client.upsertCoValue(id, TEST_HEADER);

    const closedDb = await manager.getDb();
    closedDb.close();

    const row = await client.getCoValue(id);
    expect(row?.id).toBe(id);

    expect(await manager.getDb()).not.toBe(closedDb);
  });

  test("writes succeed after the connection was closed", async () => {
    const closedDb = await manager.getDb();
    closedDb.close();

    const id = "co_ztest2" as RawCoID;
    const rowID = await client.upsertCoValue(id, TEST_HEADER);
    expect(rowID).toEqual(expect.any(Number));

    const row = await client.getCoValue(id);
    expect(row?.id).toBe(id);
  });

  test("readwrite transactions succeed after the connection was closed", async () => {
    const closedDb = await manager.getDb();
    closedDb.close();

    const id = "co_ztest3" as RawCoID;
    await client.trackCoValuesSyncState([
      { id, peerId: "peer1", synced: false },
    ]);

    expect(await client.getUnsyncedCoValueIDs()).toEqual([id]);
  });

  test("does not reopen the connection on unrelated errors", async () => {
    const id = "co_ztest4" as RawCoID;
    await client.upsertCoValue(id, TEST_HEADER);

    const dbBefore = await manager.getDb();

    // Violates the unique coValuesById index (ConstraintError), which falls
    // back to returning the existing row
    const rowID = await client.upsertCoValue(id, TEST_HEADER);
    expect(rowID).toEqual(expect.any(Number));

    expect(await manager.getDb()).toBe(dbBefore);
  });
});

test("storage keeps working after the browser closes the connection", async () => {
  const node = createTestNode();
  const manager = new IDBConnectionManager(dbName);
  const storage = new StorageApiAsync(new IDBClient(manager));
  node.setStorage(storage);

  const group = node.createGroup();
  const map = group.createMap();
  map.set("hello", "world");
  await map.core.waitForSync();

  // Simulate the browser force-closing the connection (tab suspension,
  // storage pressure, IndexedDB backend restart)
  const db = await manager.getDb();
  db.close();

  const map2 = group.createMap();
  map2.set("foo", "bar");
  await map2.core.waitForSync();

  node.gracefulShutdown();

  // Load from a fresh node to prove the write actually persisted
  const node2 = createTestNode({ secret: node.agentSecret });
  node2.setStorage(await getIndexedDBStorage());

  const loaded = await node2.load(map2.id);
  if (loaded === "unavailable") {
    throw new Error("Map is unavailable");
  }
  expect(loaded.get("foo")).toBe("bar");

  node2.gracefulShutdown();
});
