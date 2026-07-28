import {
  assert,
  afterEach,
  beforeEach,
  describe,
  expect,
  test,
  vi,
} from "vitest";

import type { JsonValue } from "../exports";
import { cojsonInternals, emptyKnownState } from "../exports";
import {
  SyncMessagesLog,
  TEST_NODE_CONFIG,
  createTestMetricReader,
  fillCoMapWithLargeData,
  loadCoValueOrFail,
  setupTestNode,
  tearDownTestMetricReader,
  waitFor,
} from "./testUtils";
import { Stringified } from "../jsonStringify";

// We want to simulate a real world communication that happens asynchronously
TEST_NODE_CONFIG.withAsyncPeers = true;

beforeEach(() => {
  cojsonInternals.setIncomingMessagesTimeBudget(10_000);
});

describe("client with storage syncs with server", () => {
  let jazzCloud: ReturnType<typeof setupTestNode>;

  beforeEach(async () => {
    SyncMessagesLog.clear();
    jazzCloud = setupTestNode({
      isSyncServer: true,
    });
  });

  test("coValue loading (empty storage)", async () => {
    const client = setupTestNode();

    client.connectToSyncServer();
    client.addStorage();

    const group = jazzCloud.node.createGroup();
    const map = group.createMap();
    map.set("hello", "world", "trusting");

    const mapOnClient = await loadCoValueOrFail(client.node, map.id);
    expect(mapOnClient.get("hello")).toEqual("world");

    expect(
      SyncMessagesLog.getMessages({
        Group: group.core,
        Map: map.core,
      }),
    ).toMatchInlineSnapshot(`
      [
        "client -> storage | LOAD Map sessions: empty",
        "storage -> client | KNOWN Map sessions: empty",
        "client -> server | LOAD Map sessions: empty",
        "server -> client | CONTENT Group header: true new: After: 0 New: 4",
        "server -> client | CONTENT Map header: true new: After: 0 New: 1",
        "client -> server | KNOWN Group sessions: header/4",
        "client -> storage | CONTENT Group header: true new: After: 0 New: 4",
        "client -> server | KNOWN Map sessions: header/1",
        "client -> storage | CONTENT Map header: true new: After: 0 New: 1",
      ]
    `);
  });

  test("coValue loading (synced storage)", async () => {
    const client = setupTestNode();

    client.connectToSyncServer();
    const { storage } = client.addStorage();

    const group = jazzCloud.node.createGroup();
    const map = group.createMap();
    map.set("hello", "world", "trusting");

    await loadCoValueOrFail(client.node, map.id);

    await client.restart();

    client.connectToSyncServer();
    client.addStorage({
      ourName: "client",
      storage,
    });

    SyncMessagesLog.clear();

    const mapOnClient = await loadCoValueOrFail(client.node, map.id);
    expect(mapOnClient.get("hello")).toEqual("world");

    expect(
      SyncMessagesLog.getMessages({
        Group: group.core,
        Map: map.core,
      }),
    ).toMatchInlineSnapshot(`
      [
        "client -> storage | LOAD Map sessions: empty",
        "storage -> client | CONTENT Group header: true new: After: 0 New: 4",
        "client -> server | LOAD Group sessions: header/4",
        "storage -> client | CONTENT Map header: true new: After: 0 New: 1",
        "client -> server | LOAD Map sessions: header/1",
      ]
    `);
  });

  test("coValue with parent groups loading", async () => {
    const client = setupTestNode();

    client.connectToSyncServer();
    client.addStorage();

    const group = jazzCloud.node.createGroup();
    const parentGroup = jazzCloud.node.createGroup();
    parentGroup.addMember("everyone", "reader");

    group.extend(parentGroup);

    const map = group.createMap();
    map.set("hello", "world");

    const mapOnClient = await loadCoValueOrFail(client.node, map.id);
    expect(mapOnClient.get("hello")).toEqual("world");

    expect(
      SyncMessagesLog.getMessages({
        ParentGroup: parentGroup.core,
        Group: group.core,
        Map: map.core,
      }),
    ).toMatchInlineSnapshot(`
      [
        "client -> storage | LOAD Map sessions: empty",
        "storage -> client | KNOWN Map sessions: empty",
        "client -> server | LOAD Map sessions: empty",
        "server -> client | CONTENT ParentGroup header: true new: After: 0 New: 6",
        "server -> client | CONTENT Group header: true new: After: 0 New: 6",
        "server -> client | CONTENT Map header: true new: After: 0 New: 1",
        "client -> server | KNOWN ParentGroup sessions: header/6",
        "client -> storage | CONTENT ParentGroup header: true new: After: 0 New: 6",
        "client -> server | KNOWN Group sessions: header/6",
        "client -> storage | CONTENT Group header: true new: After: 0 New: 6",
        "client -> server | KNOWN Map sessions: header/1",
        "client -> storage | CONTENT Map header: true new: After: 0 New: 1",
      ]
    `);
  });

  test("persists meta information", async () => {
    const client = setupTestNode();

    const { storage } = client.addStorage();

    const group = client.node.createGroup();
    const map = group.createMap();
    map.core.makeTransaction([], "trusting", {
      meta: true,
    });

    await map.core.waitForSync();

    await client.restart();

    client.addStorage({
      storage,
    });

    const loadedValue = await loadCoValueOrFail(client.node, map.id);

    // `map` is a plain (non-group) coMap, so its content is fed by the native
    // materializer (R3 stage-2b), which never populates the TS-only
    // `verifiedTransactions` introspection array (this transaction has no
    // `changes` anyway, so it produces no coMap op either way). Trigger the
    // lazy TS-side load explicitly to inspect the raw parsed meta.
    loadedValue.core.getValidTransactions();

    expect(loadedValue.core.verifiedTransactions[0]?.tx.meta).toBe(
      `{"meta":true}`,
    );

    expect(
      SyncMessagesLog.getMessages({
        Group: group.core,
        Map: map.core,
      }),
    ).toMatchInlineSnapshot(`
      [
        "client -> storage | CONTENT Group header: true new: After: 0 New: 4",
        "client -> storage | CONTENT Map header: true new: After: 0 New: 1",
        "client -> storage | LOAD Map sessions: empty",
        "storage -> client | CONTENT Group header: true new: After: 0 New: 4",
        "storage -> client | CONTENT Map header: true new: After: 0 New: 1",
      ]
    `);
  });

  test("loading a branch from storage", async () => {
    const client = setupTestNode({
      connected: true,
    });
    const { storage } = client.addStorage();

    const group = client.node.createGroup();
    const map = group.createMap();
    const branchName = "feature-branch";

    map.set("key1", "value1");
    map.set("key2", "value2");

    const branch = await client.node.checkoutBranch(map.id, branchName);

    if (branch === "unavailable") {
      throw new Error("Branch is unavailable");
    }

    branch.set("branchKey", "branchValue");
    await branch.core.waitForSync();

    await client.restart();
    client.addStorage({
      storage,
    });

    SyncMessagesLog.clear();

    const loadedBranch = await loadCoValueOrFail(client.node, branch.id);

    expect(branch.get("key1")).toBe("value1");
    expect(branch.get("key2")).toBe("value2");
    expect(branch.get("branchKey")).toBe("branchValue");

    expect(
      SyncMessagesLog.getMessages({
        Group: group.core,
        Map: map.core,
        Branch: branch.core,
      }),
    ).toMatchInlineSnapshot(`
      [
        "client -> storage | LOAD Branch sessions: empty",
        "storage -> client | CONTENT Group header: true new: After: 0 New: 4",
        "storage -> client | CONTENT Map header: true new: After: 0 New: 3",
        "storage -> client | CONTENT Branch header: true new: After: 0 New: 2",
      ]
    `);
  });

  test("updating a coValue while offline", async () => {
    const client = setupTestNode();

    client.connectToSyncServer();
    client.addStorage();

    const group = jazzCloud.node.createGroup();
    const map = group.createMap();
    map.set("hello", "world", "trusting");

    const mapOnClient = await loadCoValueOrFail(client.node, map.id);
    expect(mapOnClient.get("hello")).toEqual("world");

    client.node.syncManager.getPeers(map.id)[0]?.gracefulShutdown();

    SyncMessagesLog.clear();
    map.set("hello", "updated", "trusting");

    client.connectToSyncServer();

    await map.core.waitForSync();

    expect(mapOnClient.get("hello")).toEqual("updated");

    expect(
      SyncMessagesLog.getMessages({
        Group: group.core,
        Map: map.core,
      }),
    ).toMatchInlineSnapshot(`
      [
        "client -> server | LOAD Group sessions: header/4",
        "client -> server | LOAD Map sessions: header/1",
        "server -> client | CONTENT Map header: false new: After: 1 New: 1",
        "server -> client | KNOWN Group sessions: header/4",
        "server -> client | CONTENT Map header: false new: After: 1 New: 1",
        "client -> server | KNOWN Map sessions: header/2",
        "client -> storage | CONTENT Map header: false new: After: 1 New: 1",
        "client -> server | KNOWN Map sessions: header/2",
      ]
    `);
  });
});

describe("client syncs with a server with storage", () => {
  let jazzCloud: ReturnType<typeof setupTestNode>;
  let metricReader: ReturnType<typeof createTestMetricReader>;

  beforeEach(async () => {
    SyncMessagesLog.clear();
    metricReader = createTestMetricReader();
    jazzCloud = setupTestNode({
      isSyncServer: true,
    });
    jazzCloud.addStorage({
      ourName: "server",
    });
  });

  afterEach(() => {
    tearDownTestMetricReader();
  });

  test("coValue uploading", async () => {
    const client = setupTestNode();

    client.connectToSyncServer();

    const group = client.node.createGroup();
    const map = group.createMap();
    map.set("hello", "world", "trusting");

    await map.core.waitForSync();

    const mapOnServer = await loadCoValueOrFail(jazzCloud.node, map.id);
    expect(mapOnServer.get("hello")).toEqual("world");

    expect(
      SyncMessagesLog.getMessages({
        Group: group.core,
        Map: map.core,
      }),
    ).toMatchInlineSnapshot(`
      [
        "client -> server | CONTENT Group header: true new: After: 0 New: 4",
        "client -> server | CONTENT Map header: true new: After: 0 New: 1",
        "server -> client | KNOWN Group sessions: header/4",
        "server -> storage | CONTENT Group header: true new: After: 0 New: 4",
        "server -> client | KNOWN Map sessions: header/1",
        "server -> storage | CONTENT Map header: true new: After: 0 New: 1",
      ]
    `);
  });

  test("loading a large coValue from storage", async () => {
    const client = setupTestNode();

    client.connectToSyncServer({
      syncServer: jazzCloud.node,
    });

    const { storage } = client.addStorage({
      ourName: "client",
    });

    const group = client.node.createGroup();
    group.addMember("everyone", "writer");

    const largeMap = group.createMap();

    fillCoMapWithLargeData(largeMap);

    await largeMap.core.waitForSync();

    expect(
      SyncMessagesLog.getMessages({
        Group: group.core,
        Map: largeMap.core,
      }),
    ).toMatchInlineSnapshot(`
      [
        "client -> storage | CONTENT Group header: true new: After: 0 New: 6",
        "client -> server | CONTENT Group header: true new: After: 0 New: 6",
        "client -> storage | CONTENT Map header: true new: After: 0 New: 73 expectContentUntil: header/200",
        "client -> server | CONTENT Map header: true new: After: 0 New: 73 expectContentUntil: header/200",
        "client -> storage | CONTENT Map header: false new: After: 73 New: 73",
        "client -> server | CONTENT Map header: false new: After: 73 New: 73",
        "client -> storage | CONTENT Map header: false new: After: 146 New: 54",
        "client -> server | CONTENT Map header: false new: After: 146 New: 54",
        "server -> client | KNOWN Group sessions: header/6",
        "server -> storage | CONTENT Group header: true new: After: 0 New: 6",
        "server -> client | KNOWN Map sessions: header/73",
        "server -> storage | CONTENT Map header: true new: After: 0 New: 73",
        "server -> client | KNOWN Map sessions: header/146",
        "server -> storage | CONTENT Map header: false new: After: 73 New: 73",
        "server -> client | KNOWN Map sessions: header/200",
        "server -> storage | CONTENT Map header: false new: After: 146 New: 54",
      ]
    `);

    SyncMessagesLog.clear();

    await client.restart();

    client.connectToSyncServer({
      ourName: "client",
      syncServer: jazzCloud.node,
    });

    client.addStorage({
      ourName: "client",
      storage,
    });

    const promise = loadCoValueOrFail(client.node, largeMap.id);

    const mapOnClient2 = await promise;
    await mapOnClient2.core.waitForFullStreaming();

    expect(
      SyncMessagesLog.getMessages({
        Group: group.core,
        Map: largeMap.core,
      }),
    ).toMatchInlineSnapshot(`
      [
        "client -> storage | LOAD Map sessions: empty",
        "storage -> client | CONTENT Group header: true new: After: 0 New: 6",
        "client -> server | LOAD Group sessions: header/6",
        "storage -> client | CONTENT Map header: true new: After: 0 New: 73 expectContentUntil: header/200",
        "client -> server | LOAD Map sessions: header/200",
        "storage -> client | CONTENT Map header: true new: After: 73 New: 73",
        "storage -> client | CONTENT Map header: true new: After: 146 New: 54",
      ]
    `);
  });

  test("storing stale data should not compromise the signatures", async () => {
    const client = setupTestNode();

    client.connectToSyncServer({
      syncServer: jazzCloud.node,
    });

    const { storage } = client.addStorage({
      ourName: "client",
    });

    const group = client.node.createGroup();
    group.addMember("everyone", "writer");

    const largeMap = group.createMap();

    // Generate a large amount of data (about 100MB)
    fillCoMapWithLargeData(largeMap);

    await largeMap.core.waitForSync();

    const newContentChunks = largeMap.core.newContentSince(
      emptyKnownState(largeMap.id),
    );

    assert(newContentChunks);
    assert(newContentChunks.length > 1);

    const correctionSpy = vi.fn();

    client.node.storage?.store(newContentChunks[1]!, correctionSpy);

    expect(correctionSpy).not.toHaveBeenCalled();

    await client.restart();

    client.connectToSyncServer({
      ourName: "client",
      syncServer: jazzCloud.node,
    });

    client.addStorage({
      ourName: "client",
      storage,
    });

    const mapOnClient2 = await loadCoValueOrFail(client.node, largeMap.id);

    await waitFor(async () => {
      expect(mapOnClient2.core.knownState()).toEqual(
        largeMap.core.knownState(),
      );
    });
  });

  test("sessions with invalid assumptions should not be attempted to be stored", async () => {
    const client = setupTestNode();
    client.connectToSyncServer();

    const serverStorage = jazzCloud.node.storage!;

    const group = client.node.createGroup();
    const map = group.createMap();

    // Set an initial value on the map and let client/server sync
    map.set("hello", "world", "trusting");
    await map.core.waitForSync();

    // Verify that the initial known state is in server storage
    const initialKnownState = map.core.knownState();
    expect(serverStorage.getKnownState(map.id)).toEqual(initialKnownState);

    // Disable the next invocation of handleNewContent on the server
    vi.spyOn(
      jazzCloud.node.syncManager,
      "handleNewContent",
    ).mockImplementationOnce(() => {}); // noop

    // Update the map and let the client try to send the new content to the server.
    // The server won't receive it since it's disabled.
    map.set("hello", "world2", "trusting");
    await new Promise((resolve) => setTimeout(resolve, 100));

    // Verify that the known state is still the same in server storage
    expect(serverStorage.getKnownState(map.id)).toEqual(initialKnownState);

    const storeSpy = vi.spyOn(serverStorage, "store");

    // Update the map once again, causing the client to send an update that the server
    // can't handle due to the previous transaction being missing. This will be followed
    // up by another update containing the missing transaction.
    map.set("hello", "world3", "trusting");
    await map.core.waitForSync();

    // We expect store() to have only been called once even though handleNewContent()
    // will have been called twice. The first handleNewContent call would have been
    // "unstorable" because of the missing transaction.
    expect(storeSpy).toHaveBeenCalledTimes(1);

    // Verify that the known state is updated in server storage
    expect(serverStorage.getKnownState(map.id)).toEqual(map.core.knownState());
  });

  test("sessions with invalid signatures should not be attempted to be stored", async () => {
    // Create a new client, to prepare the map
    const alice = setupTestNode({
      connected: true,
    });
    const group = alice.node.createGroup();
    group.addMember("everyone", "writer");
    const map = group.createMap();

    // Set an initial value on the map and let client/server sync
    map.set("hello", "world", "trusting");
    await map.core.waitForSync();

    const knwonStateAfterFirstUpdate = map.core.knownState();

    // Spawn another client, to add a new session and generate the content with an invalid signature
    const bob = setupTestNode({
      connected: true,
    });

    // Load the map and update it with a new session
    const mapOnBob = await loadCoValueOrFail(bob.node, map.id);
    mapOnBob.set("hello", "world2", "trusting");
    await mapOnBob.core.waitForSync();

    const client = setupTestNode();
    const { storage } = client.addStorage();

    SyncMessagesLog.clear(); // We want to focus on the sync messages happening from now

    // Import the group in the client, to have the dependencies availble and test that the import persists on storage
    const groupContent = group.core.newContentSince(undefined)?.[0];
    assert(groupContent);
    client.node.syncManager.handleNewContent(groupContent, "import");
    expect(storage.getKnownState(groupContent.id)).toEqual(
      group.core.knownState(),
    );

    // Export the map content with the two sessions
    const mapContent = mapOnBob.core.newContentSince(undefined)?.[0];
    assert(mapContent);

    // Tamper Bob's session
    const invalidMapContent = structuredClone(mapContent);
    invalidMapContent.new[bob.node.currentSessionID]!.newTransactions.push({
      privacy: "trusting",
      changes: JSON.stringify([
        { op: "set", key: "hello", value: "updated" },
      ]) as Stringified<JsonValue[]>,
      madeAt: Date.now(),
    });
    client.node.syncManager.handleNewContent(invalidMapContent, "import");

    // We should store only Alice's session, because Bob's session is invalid
    expect(client.node.storage?.getKnownState(map.id)).toEqual(
      knwonStateAfterFirstUpdate,
    );

    expect(
      SyncMessagesLog.getMessages({
        Group: group.core,
        Map: map.core,
      }),
    ).toMatchInlineSnapshot(`
      [
        "client -> storage | CONTENT Group header: true new: After: 0 New: 6",
        "client -> storage | CONTENT Map header: true new: After: 0 New: 1",
      ]
    `);
  });

  test("should store values with no transactions", async () => {
    const alice = setupTestNode();
    alice.connectToSyncServer({
      ourName: "alice",
    });
    const group = alice.node.createGroup();
    group.addMember("everyone", "writer");
    const map = group.createMap();

    await map.core.waitForSync();

    const bob = setupTestNode();
    bob.connectToSyncServer({
      ourName: "bob",
    });
    const { storage } = bob.addStorage({
      ourName: "bob",
    });

    await loadCoValueOrFail(bob.node, map.id);

    // The map should be stored in bob's storage
    expect(storage.getKnownState(map.id)).toEqual({
      header: true,
      id: map.id,
      sessions: {},
    });

    expect(
      SyncMessagesLog.getMessages({
        Group: group.core,
        Map: map.core,
      }),
    ).toMatchInlineSnapshot(`
      [
        "alice -> server | CONTENT Group header: true new: After: 0 New: 6",
        "alice -> server | CONTENT Map header: true new: ",
        "bob -> storage | LOAD Map sessions: empty",
        "storage -> bob | KNOWN Map sessions: empty",
        "bob -> server | LOAD Map sessions: empty",
        "server -> alice | KNOWN Group sessions: header/6",
        "server -> storage | CONTENT Group header: true new: After: 0 New: 6",
        "server -> alice | KNOWN Map sessions: header/0",
        "server -> storage | CONTENT Map header: true new: ",
        "server -> bob | CONTENT Group header: true new: After: 0 New: 6",
        "server -> bob | CONTENT Map header: true new: ",
        "bob -> server | KNOWN Group sessions: header/6",
        "bob -> storage | CONTENT Group header: true new: After: 0 New: 6",
        "bob -> server | KNOWN Map sessions: header/0",
        "bob -> storage | CONTENT Map header: true new: ",
      ]
    `);
  });

  test("when falling back to network, we should never emit unavailable", async () => {
    const client = setupTestNode({
      connected: true,
    });

    const group = client.node.createGroup();
    const map = group.createMap();
    group.addMember("everyone", "reader");
    map.set("hello", "world");

    await map.core.waitForSync();

    const newSession = client.spawnNewSession();
    newSession.addStorage({
      ourName: "newSession",
    });

    const coValue = newSession.node.getCoValue(map.id);
    const spy = vi.fn();
    coValue.subscribe((core) => {
      spy(core.loadingState);
    });

    await newSession.node.loadCoValueCore(map.id, undefined, true);

    expect(spy).not.toHaveBeenCalledWith("unavailable");
    expect(coValue.loadingState).toBe("available");

    expect(
      SyncMessagesLog.getMessages({
        Group: group.core,
        Map: map.core,
      }),
    ).toMatchInlineSnapshot(`
      [
        "client -> server | CONTENT Group header: true new: After: 0 New: 4",
        "client -> server | CONTENT Map header: true new: ",
        "client -> server | CONTENT Group header: false new: After: 4 New: 2",
        "client -> server | CONTENT Map header: false new: After: 0 New: 1",
        "server -> client | KNOWN Group sessions: header/4",
        "server -> storage | CONTENT Group header: true new: After: 0 New: 4",
        "server -> client | KNOWN Map sessions: header/0",
        "server -> storage | CONTENT Map header: true new: ",
        "server -> client | KNOWN Group sessions: header/6",
        "server -> storage | CONTENT Group header: false new: After: 4 New: 2",
        "server -> client | KNOWN Map sessions: header/1",
        "server -> storage | CONTENT Map header: false new: After: 0 New: 1",
        "newSession -> storage | LOAD Map sessions: empty",
        "storage -> newSession | KNOWN Map sessions: empty",
        "client -> server | LOAD Map sessions: empty",
        "server -> client | CONTENT Group header: true new: After: 0 New: 6",
        "server -> client | CONTENT Map header: true new: After: 0 New: 1",
        "client -> server | KNOWN Group sessions: header/6",
        "newSession -> storage | CONTENT Group header: true new: After: 0 New: 6",
        "client -> server | KNOWN Map sessions: header/1",
        "newSession -> storage | CONTENT Map header: true new: After: 0 New: 1",
      ]
    `);
  });

  test("large parent group streaming from storage", async () => {
    const syncServer = setupTestNode({
      isSyncServer: true,
    });
    const { storage } = syncServer.addStorage({
      ourName: "syncServer",
    });

    const alice = setupTestNode();
    alice.connectToSyncServer({
      syncServer: syncServer.node,
    });

    const parentGroup = alice.node.createGroup();
    const group = alice.node.createGroup();
    group.extend(parentGroup);

    const map = group.createMap();

    fillCoMapWithLargeData(parentGroup);

    parentGroup.addMember("everyone", "reader");

    map.set("hello", "world");

    await map.core.waitForSync();
    await parentGroup.core.waitForSync();

    expect(
      SyncMessagesLog.getMessages({
        Group: group.core,
        ParentGroup: parentGroup.core,
        Map: map.core,
      }),
    ).toMatchInlineSnapshot(`
      [
        "client -> server | CONTENT ParentGroup header: true new: After: 0 New: 4",
        "client -> server | CONTENT Group header: true new: After: 0 New: 6",
        "client -> server | CONTENT Map header: true new: ",
        "client -> server | CONTENT ParentGroup header: false new: After: 4 New: 73 expectContentUntil: header/206",
        "client -> server | CONTENT ParentGroup header: false new: After: 77 New: 73",
        "client -> server | CONTENT ParentGroup header: false new: After: 150 New: 56",
        "client -> server | CONTENT Map header: false new: After: 0 New: 1",
        "server -> client | KNOWN ParentGroup sessions: header/4",
        "syncServer -> storage | CONTENT ParentGroup header: true new: After: 0 New: 4",
        "server -> client | KNOWN Group sessions: header/6",
        "syncServer -> storage | CONTENT Group header: true new: After: 0 New: 6",
        "server -> client | KNOWN Map sessions: header/0",
        "syncServer -> storage | CONTENT Map header: true new: ",
        "server -> client | KNOWN ParentGroup sessions: header/77",
        "syncServer -> storage | CONTENT ParentGroup header: false new: After: 4 New: 73",
        "server -> client | KNOWN ParentGroup sessions: header/150",
        "syncServer -> storage | CONTENT ParentGroup header: false new: After: 77 New: 73",
        "server -> client | KNOWN ParentGroup sessions: header/206",
        "syncServer -> storage | CONTENT ParentGroup header: false new: After: 150 New: 56",
        "server -> client | KNOWN Map sessions: header/1",
        "syncServer -> storage | CONTENT Map header: false new: After: 0 New: 1",
      ]
    `);

    SyncMessagesLog.clear();

    await syncServer.restart();
    syncServer.addStorage({
      ourName: "syncServer",
      storage,
    });

    const bob = setupTestNode();
    bob.connectToSyncServer({
      syncServer: syncServer.node,
      ourName: "bob",
    });

    let mapOnBob = await loadCoValueOrFail(bob.node, map.id);

    await mapOnBob.core.waitForAsync((value) => value.isCompletelyDownloaded());

    expect(
      SyncMessagesLog.getMessages({
        ParentGroup: parentGroup.core,
        Group: group.core,
        Map: map.core,
      }),
    ).toMatchInlineSnapshot(`
      [
        "bob -> server | LOAD Map sessions: empty",
        "syncServer -> storage | LOAD Map sessions: empty",
        "storage -> syncServer | CONTENT ParentGroup header: true new: After: 0 New: 77 expectContentUntil: header/206",
        "storage -> syncServer | CONTENT Group header: true new: After: 0 New: 6",
        "storage -> syncServer | CONTENT Map header: true new: After: 0 New: 1",
        "server -> bob | CONTENT ParentGroup header: true new: After: 0 New: 77 expectContentUntil: header/206",
        "server -> bob | CONTENT Group header: true new: After: 0 New: 6",
        "server -> bob | CONTENT Map header: true new: After: 0 New: 1",
        "server -> bob | KNOWN Map sessions: header/1",
        "storage -> syncServer | CONTENT ParentGroup header: true new: After: 77 New: 73",
        "server -> bob | CONTENT ParentGroup header: false new: After: 77 New: 73 expectContentUntil: header/206",
        "storage -> syncServer | CONTENT ParentGroup header: true new: After: 150 New: 56",
        "server -> bob | CONTENT ParentGroup header: false new: After: 150 New: 56",
        "bob -> server | KNOWN ParentGroup sessions: header/77",
        "bob -> server | KNOWN Group sessions: header/6",
        "bob -> server | KNOWN Map sessions: header/1",
        "bob -> server | KNOWN ParentGroup sessions: header/150",
        "bob -> server | KNOWN ParentGroup sessions: header/206",
      ]
    `);

    expect(mapOnBob.get("hello")).toEqual("world");
  });

  describe("storage content streaming queue", () => {
    test("multiple CoValues can stream concurrently", async () => {
      cojsonInternals.setIncomingMessagesTimeBudget(0); // Should force the queue processing to be async

      const client = setupTestNode();
      client.connectToSyncServer();
      const { storage } = client.addStorage();

      const group = jazzCloud.node.createGroup();
      const map1 = group.createMap();
      const map2 = group.createMap();
      const map3 = group.createMap();

      fillCoMapWithLargeData(map1);
      fillCoMapWithLargeData(map2);
      fillCoMapWithLargeData(map3);

      // Load all and sync to storage
      await Promise.all([
        loadCoValueOrFail(client.node, map1.id),
        loadCoValueOrFail(client.node, map2.id),
        loadCoValueOrFail(client.node, map3.id),
      ]);
      await Promise.all([
        map1.core.waitForSync(),
        map2.core.waitForSync(),
        map3.core.waitForSync(),
      ]);

      // Restart to load from storage
      await client.restart();
      client.addStorage({ storage });

      // Load all maps concurrently from storage
      const [loadedMap1, loadedMap2, loadedMap3] = await Promise.all([
        loadCoValueOrFail(client.node, map1.id),
        loadCoValueOrFail(client.node, map2.id),
        loadCoValueOrFail(client.node, map3.id),
      ]);

      // Wait for all to complete streaming
      await Promise.all([
        loadedMap1.core.waitForAsync((value) => value.isCompletelyDownloaded()),
        loadedMap2.core.waitForAsync((value) => value.isCompletelyDownloaded()),
        loadedMap3.core.waitForAsync((value) => value.isCompletelyDownloaded()),
      ]);

      // All content should be loaded
      expect(loadedMap1.core.isCompletelyDownloaded()).toBe(true);
      expect(loadedMap2.core.isCompletelyDownloaded()).toBe(true);
      expect(loadedMap3.core.isCompletelyDownloaded()).toBe(true);

      // Queue should be empty
      expect(storage.streamingQueue?.isEmpty()).toBe(true);
    });

    test("large content streaming interleaved with incoming messages", async () => {
      cojsonInternals.setIncomingMessagesTimeBudget(0); // Should force the queue processing to be async

      const client = setupTestNode();
      client.connectToSyncServer();
      const { storage } = client.addStorage();

      // Create a large map on the server and sync to client storage
      const group = jazzCloud.node.createGroup();
      const largeMap = group.createMap();
      fillCoMapWithLargeData(largeMap);

      await loadCoValueOrFail(client.node, largeMap.id);
      await largeMap.core.waitForSync();

      SyncMessagesLog.clear();

      // Restart client with storage
      await client.restart();
      client.connectToSyncServer();
      client.addStorage({ storage });

      // Create a new small map on the server (will come as incoming message)
      const smallMap = group.createMap();
      smallMap.set("hello", "world", "trusting");

      // Load both simultaneously - large from storage, small from server
      const [loadedLargeMap, loadedSmallMap] = await Promise.all([
        loadCoValueOrFail(client.node, largeMap.id),
        loadCoValueOrFail(client.node, smallMap.id),
      ]);

      // Wait for complete download
      await Promise.all([
        loadedLargeMap.core.waitForAsync((value) =>
          value.isCompletelyDownloaded(),
        ),
        loadedSmallMap.core.waitForAsync((value) =>
          value.isCompletelyDownloaded(),
        ),
      ]);

      // Both should be loaded correctly
      expect(loadedLargeMap.core.isCompletelyDownloaded()).toBe(true);
      expect(loadedSmallMap.get("hello")).toEqual("world");
    });

    test("large parent group streaming from storage", async () => {
      cojsonInternals.setIncomingMessagesTimeBudget(0);

      const syncServer = setupTestNode({
        isSyncServer: true,
      });
      const { storage } = syncServer.addStorage({
        ourName: "syncServer",
      });

      const alice = setupTestNode();
      alice.connectToSyncServer({
        syncServer: syncServer.node,
      });

      const parentGroup = alice.node.createGroup();
      const group = alice.node.createGroup();
      group.extend(parentGroup);

      const map = group.createMap();

      fillCoMapWithLargeData(parentGroup);

      parentGroup.addMember("everyone", "reader");

      map.set("hello", "world");

      await map.core.waitForSync();
      await parentGroup.core.waitForSync();

      expect(
        SyncMessagesLog.getMessages({
          Group: group.core,
          ParentGroup: parentGroup.core,
          Map: map.core,
        }),
      ).toMatchInlineSnapshot(`
        [
          "client -> server | CONTENT ParentGroup header: true new: After: 0 New: 4",
          "client -> server | CONTENT Group header: true new: After: 0 New: 6",
          "client -> server | CONTENT Map header: true new: ",
          "client -> server | CONTENT ParentGroup header: false new: After: 4 New: 73 expectContentUntil: header/206",
          "client -> server | CONTENT ParentGroup header: false new: After: 77 New: 73",
          "client -> server | CONTENT ParentGroup header: false new: After: 150 New: 56",
          "client -> server | CONTENT Map header: false new: After: 0 New: 1",
          "server -> client | KNOWN ParentGroup sessions: header/4",
          "syncServer -> storage | CONTENT ParentGroup header: true new: After: 0 New: 4",
          "server -> client | KNOWN Group sessions: header/6",
          "syncServer -> storage | CONTENT Group header: true new: After: 0 New: 6",
          "server -> client | KNOWN Map sessions: header/0",
          "syncServer -> storage | CONTENT Map header: true new: ",
          "server -> client | KNOWN ParentGroup sessions: header/77",
          "syncServer -> storage | CONTENT ParentGroup header: false new: After: 4 New: 73",
          "server -> client | KNOWN ParentGroup sessions: header/150",
          "syncServer -> storage | CONTENT ParentGroup header: false new: After: 77 New: 73",
          "server -> client | KNOWN ParentGroup sessions: header/206",
          "syncServer -> storage | CONTENT ParentGroup header: false new: After: 150 New: 56",
          "server -> client | KNOWN Map sessions: header/1",
          "syncServer -> storage | CONTENT Map header: false new: After: 0 New: 1",
        ]
      `);

      SyncMessagesLog.clear();

      await syncServer.restart();
      syncServer.addStorage({
        ourName: "syncServer",
        storage,
      });

      const bob = setupTestNode();
      bob.connectToSyncServer({
        syncServer: syncServer.node,
        ourName: "bob",
      });

      let mapOnBob = await loadCoValueOrFail(bob.node, map.id);

      await mapOnBob.core.waitForAsync((value) =>
        value.isCompletelyDownloaded(),
      );

      expect(
        SyncMessagesLog.getMessages({
          ParentGroup: parentGroup.core,
          Group: group.core,
          Map: map.core,
        }),
      ).toMatchInlineSnapshot(`
        [
          "bob -> server | LOAD Map sessions: empty",
          "syncServer -> storage | LOAD Map sessions: empty",
          "storage -> syncServer | CONTENT ParentGroup header: true new: After: 0 New: 77 expectContentUntil: header/206",
          "storage -> syncServer | CONTENT Group header: true new: After: 0 New: 6",
          "storage -> syncServer | CONTENT Map header: true new: After: 0 New: 1",
          "server -> bob | CONTENT ParentGroup header: true new: After: 0 New: 77 expectContentUntil: header/206",
          "server -> bob | CONTENT Group header: true new: After: 0 New: 6",
          "server -> bob | CONTENT Map header: true new: After: 0 New: 1",
          "server -> bob | KNOWN Map sessions: header/1",
          "storage -> syncServer | CONTENT ParentGroup header: true new: After: 77 New: 73",
          "server -> bob | CONTENT ParentGroup header: false new: After: 77 New: 73 expectContentUntil: header/206",
          "storage -> syncServer | CONTENT ParentGroup header: true new: After: 150 New: 56",
          "server -> bob | CONTENT ParentGroup header: false new: After: 150 New: 56",
          "bob -> server | KNOWN ParentGroup sessions: header/77",
          "bob -> server | KNOWN Group sessions: header/6",
          "bob -> server | KNOWN Map sessions: header/1",
          "bob -> server | KNOWN ParentGroup sessions: header/150",
          "bob -> server | KNOWN ParentGroup sessions: header/206",
        ]
      `);

      expect(mapOnBob.get("hello")).toEqual("world");
    });
  });
});
