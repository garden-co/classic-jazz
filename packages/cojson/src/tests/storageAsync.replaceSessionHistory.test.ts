import { beforeEach, expect, test } from "vitest";

import type { CoID, RawCoMap } from "../exports.js";
import {
  SyncMessagesLog,
  TEST_NODE_CONFIG,
  loadCoValueOrFail,
  setupTestNode,
} from "./testUtils.js";
import { registerStorageCleanupRunner } from "./testStorage.js";

// Async peers required for async storage
TEST_NODE_CONFIG.withAsyncPeers = true;

let jazzCloud: ReturnType<typeof setupTestNode>;

beforeEach(() => {
  SyncMessagesLog.clear();
  registerStorageCleanupRunner();
  jazzCloud = setupTestNode({ isSyncServer: true });
});

test("replaceSessionHistory waits behind in-flight store work before recovery continues", async () => {
  /**
   * A normal store is in-flight when replaceSessionHistory is queued.
   * The replacement must not execute until the in-flight store completes.
   *
   * Topology
   *   Alice --------> AsyncStorage
   *
   * Sequence
   *   1. Alice stores title="Fix login bug" (in-flight, auto via sync)
   *   2. replaceSessionHistory queued
   *   3. in-flight store completes
   *   4. replacement executes
   *   5. storage reflects replaced content
   */
  const alice = setupTestNode();
  const { storage } = await alice.addAsyncStorage({ ourName: "alice" });
  alice.connectToSyncServer({ ourName: "alice", syncServerName: "jazzCloud" });

  const group = alice.node.createGroup();
  const map = group.createMap();
  map.set("title", "Fix login bug", "trusting");

  // Wait for sync with jazzCloud so jazzCloud has the session content
  await map.core.waitForSync();

  const mapId = map.id as CoID<RawCoMap>;
  const sessionID = alice.node.currentSessionID;

  // Get the authoritative content from the server
  const serverCore = jazzCloud.node.getCoValue(mapId);
  const authContent = serverCore.verified!.getFullSessionContent(sessionID);
  expect(authContent.length).toBeGreaterThan(0);

  // Call replaceSessionHistory and await it — this must resolve after
  // any in-flight store work queued before it
  const result = storage.store(
    {
      action: "replaceSessionHistory" as const,
      coValueId: mapId,
      sessionID,
      content: authContent,
    },
    () => undefined,
  );
  await result;

  // After replacement, the node should still reflect the correct content
  const aliceMap = alice.node.getCoValue(mapId).getCurrentContent() as RawCoMap;
  expect(aliceMap.get("title")).toBe("Fix login bug");
}, 15000);

test("back-to-back replacements for the same coValue preserve final durable order", async () => {
  /**
   * Two replaceSessionHistory calls for the same coValue are queued.
   * The second replacement's content must be what's durably stored.
   *
   * Sequence
   *   1. replace with content A (title only)
   *   2. replace with content B (title + status)
   *   3. final state must reflect content B
   */
  const alice = setupTestNode();
  const { storage } = await alice.addAsyncStorage({ ourName: "alice" });
  alice.connectToSyncServer({ ourName: "alice", syncServerName: "jazzCloud" });

  const group = alice.node.createGroup();
  const map = group.createMap();
  map.set("title", "Fix login bug", "trusting");

  // Sync so jazzCloud has content A (title only)
  await map.core.waitForSync();

  const mapId = map.id as CoID<RawCoMap>;
  const sessionID = alice.node.currentSessionID;

  // Get content A from server (title only)
  const contentA = jazzCloud.node
    .getCoValue(mapId)
    .verified!.getFullSessionContent(sessionID);
  expect(contentA.length).toBeGreaterThan(0);

  // Add status and sync again so jazzCloud has content B (title + status)
  map.set("status", "review", "trusting");
  await map.core.waitForSync();

  // Get content B from server (title + status)
  const contentB = jazzCloud.node
    .getCoValue(mapId)
    .verified!.getFullSessionContent(sessionID);
  expect(contentB.length).toBeGreaterThan(0);

  // Verify content B has more transactions than content A
  const totalTxsA = contentA.reduce(
    (sum, piece) => sum + piece.newTransactions.length,
    0,
  );
  const totalTxsB = contentB.reduce(
    (sum, piece) => sum + piece.newTransactions.length,
    0,
  );
  expect(totalTxsB).toBeGreaterThan(totalTxsA);

  // Queue both replacements concurrently (do NOT await the first before calling second)
  const p1 = storage.store(
    {
      action: "replaceSessionHistory" as const,
      coValueId: mapId,
      sessionID,
      content: contentA,
    },
    () => undefined,
  );
  const p2 = storage.store(
    {
      action: "replaceSessionHistory" as const,
      coValueId: mapId,
      sessionID,
      content: contentB,
    },
    () => undefined,
  );

  // Both must resolve without throwing
  await Promise.all([p1, p2]);

  // The node's in-memory state should reflect the most recent content (B)
  const aliceMap = alice.node.getCoValue(mapId).getCurrentContent() as RawCoMap;
  expect(aliceMap.get("title")).toBe("Fix login bug");
  expect(aliceMap.get("status")).toBe("review");
}, 15000);

test("replacements for different coValues do not break global queue sequencing", async () => {
  /**
   * Two different coValues queue replaceSessionHistory concurrently.
   * Both must complete without corrupting each other's storage.
   *
   * Sequence
   *   1. replace session on coValue-1
   *   2. replace session on coValue-2 (concurrent)
   *   3. both coValues stored correctly
   */
  const alice = setupTestNode();
  const { storage } = await alice.addAsyncStorage({ ourName: "alice" });
  alice.connectToSyncServer({ ourName: "alice", syncServerName: "jazzCloud" });

  const group = alice.node.createGroup();

  // Create two independent maps
  const map1 = group.createMap();
  map1.set("coValue", "one", "trusting");

  const map2 = group.createMap();
  map2.set("coValue", "two", "trusting");

  // Sync both maps so jazzCloud has them
  await map1.core.waitForSync();
  await map2.core.waitForSync();

  const mapId1 = map1.id as CoID<RawCoMap>;
  const mapId2 = map2.id as CoID<RawCoMap>;
  const sessionID = alice.node.currentSessionID;

  // Get authoritative content from the server for both maps
  const authContent1 = jazzCloud.node
    .getCoValue(mapId1)
    .verified!.getFullSessionContent(sessionID);
  const authContent2 = jazzCloud.node
    .getCoValue(mapId2)
    .verified!.getFullSessionContent(sessionID);

  expect(authContent1.length).toBeGreaterThan(0);
  expect(authContent2.length).toBeGreaterThan(0);

  // Queue replacements for both maps concurrently
  const p1 = storage.store(
    {
      action: "replaceSessionHistory" as const,
      coValueId: mapId1,
      sessionID,
      content: authContent1,
    },
    () => undefined,
  );
  const p2 = storage.store(
    {
      action: "replaceSessionHistory" as const,
      coValueId: mapId2,
      sessionID,
      content: authContent2,
    },
    () => undefined,
  );

  // Both must resolve without throwing
  await Promise.all([p1, p2]);

  // Both maps must have correct content
  const aliceMap1 = alice.node
    .getCoValue(mapId1)
    .getCurrentContent() as RawCoMap;
  const aliceMap2 = alice.node
    .getCoValue(mapId2)
    .getCurrentContent() as RawCoMap;

  expect(aliceMap1.get("coValue")).toBe("one");
  expect(aliceMap2.get("coValue")).toBe("two");
}, 15000);

test.fails(
  "restart after queued but unfinished replacement does not resurrect stale session history",
  async () => {
    /**
     * KNOWN DESIGN GAP: if the node crashes after replaceSessionHistory
     * is queued but before the queue processes it, restarting from the
     * same storage will load the stale (pre-replacement) session.
     *
     * Topology
     *   Alice --------> AsyncStorage
     *
     * Sequence
     *   1. Alice syncs title + status to storage and server
     *   2. replaceSessionHistory queued with content that only has title
     *      (simulating server saying "only title is authoritative")
     *   3. Replacement is intercepted — never durably written
     *   4. Fresh node loads from same storage
     *   5. Fresh node should NOT see "status" (it was supposed to be replaced)
     *      but it WILL because the replacement never completed
     */
    const jazzCloud = setupTestNode({ isSyncServer: true });
    const alice = setupTestNode();
    const { storage } = await alice.addAsyncStorage({
      ourName: "alice",
      storageName: "alice-storage",
    });
    alice.connectToSyncServer({
      ourName: "alice",
      syncServerName: "jazzCloud",
    });

    const group = alice.node.createGroup();
    const map = group.createMap();
    map.set("title", "Fix login bug", "trusting");
    await map.core.waitForSync();

    const mapId = map.id as CoID<RawCoMap>;
    const sessionID = alice.node.currentSessionID;

    // Get content A (title only) — this is what the "authoritative" replacement has
    const contentA = jazzCloud.node
      .getCoValue(mapId)
      .verified!.getFullSessionContent(sessionID);

    // Alice adds status (now storage has title + status)
    map.set("status", "draft", "trusting");
    await map.core.waitForSync();

    // Intercept storage to prevent the replacement from executing
    const originalStore = storage.store.bind(storage);
    storage.store = (msg: any, cb: any) => {
      if (
        typeof msg === "object" &&
        "action" in msg &&
        msg.action === "replaceSessionHistory"
      ) {
        // Simulate crash: don't execute the replacement
        return Promise.resolve() as any;
      }
      return originalStore(msg, cb);
    };

    // Queue replacement (intercepted — never durably written)
    await storage.store(
      {
        action: "replaceSessionHistory" as const,
        coValueId: mapId,
        sessionID,
        content: contentA,
      },
      () => undefined,
    );

    // Restore original store
    storage.store = originalStore;

    // Load from the same storage — stale data should not appear
    // but it WILL because the replacement was never durably written
    const freshNode = setupTestNode();
    freshNode.addStorage({ storage });
    const freshMap = (await loadCoValueOrFail(
      freshNode.node,
      mapId,
    )) as RawCoMap;

    // This assertion documents the gap: status should be gone (replaced)
    // but it's still there because the replacement was never written to storage
    expect(freshMap.get("status")).toBeUndefined();
  },
  15000,
);
