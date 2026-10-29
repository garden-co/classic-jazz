import { assert, beforeEach, describe, expect, test } from "vitest";

import { expectList, expectMap } from "../coValue";
import { WasmCrypto } from "../crypto/WasmCrypto";
import {
  SyncMessagesLog,
  TEST_NODE_CONFIG,
  fillCoMapWithLargeData,
  loadCoValueOrFail,
  setupTestNode,
  waitFor,
} from "./testUtils";
import { RawCoMap } from "../coValues/coMap";

// We want to simulate a real world communication that happens asynchronously
TEST_NODE_CONFIG.withAsyncPeers = true;

const Crypto = await WasmCrypto.create();
let jazzCloud: ReturnType<typeof setupTestNode>;

beforeEach(async () => {
  SyncMessagesLog.clear();
  jazzCloud = setupTestNode({ isSyncServer: true });
});

describe("client to server upload", () => {
  test("coValue uploading", async () => {
    const client = setupTestNode({
      connected: true,
    });

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
        "server -> client | KNOWN Map sessions: header/1",
      ]
    `);
  });

  test("creating a branch", async () => {
    const client = setupTestNode({
      connected: true,
    });

    const group = jazzCloud.node.createGroup();
    group.addMember("everyone", "writer");
    const map = group.createMap();
    const branchName = "feature-branch";

    map.set("key1", "value1");
    map.set("key2", "value2");

    await map.core.waitForSync();

    SyncMessagesLog.clear();

    const branch = await client.node.checkoutBranch(map.id, branchName);

    if (branch === "unavailable") {
      throw new Error("Branch is unavailable");
    }

    branch.set("branchKey", "branchValue");

    await branch.core.waitForSync();

    expect(
      SyncMessagesLog.getMessages({
        Group: group.core,
        Map: map.core,
        Branch: branch.core,
      }),
    ).toMatchInlineSnapshot(`
      [
        "client -> server | LOAD Map sessions: empty",
        "server -> client | CONTENT Group header: true new: After: 0 New: 6",
        "server -> client | CONTENT Map header: true new: After: 0 New: 2",
        "client -> server | KNOWN Group sessions: header/6",
        "client -> server | KNOWN Map sessions: header/2",
        "client -> server | CONTENT Branch header: true new: After: 0 New: 1",
        "client -> server | CONTENT Map header: false new: After: 0 New: 1",
        "client -> server | CONTENT Branch header: false new: After: 1 New: 1",
        "server -> client | KNOWN Branch sessions: header/1",
        "server -> client | KNOWN Map sessions: header/3",
        "server -> client | KNOWN Branch sessions: header/2",
      ]
    `);
  });

  test("syncs meta information", async () => {
    const client = setupTestNode({
      connected: true,
    });

    const group = client.node.createGroup();
    const map = group.createMap();
    map.core.makeTransaction([], "trusting", {
      meta: true,
    });

    await map.core.waitForSync();

    const loadedValue = await loadCoValueOrFail(jazzCloud.node, map.id);

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
        "client -> server | CONTENT Group header: true new: After: 0 New: 4",
        "client -> server | CONTENT Map header: true new: After: 0 New: 1",
        "server -> client | KNOWN Group sessions: header/4",
        "server -> client | KNOWN Map sessions: header/1",
      ]
    `);
  });

  test("coValue with parent groups uploading", async () => {
    const client = setupTestNode({
      connected: true,
    });

    const group = client.node.createGroup();
    const parentGroup = client.node.createGroup();
    parentGroup.addMember("everyone", "reader");

    group.extend(parentGroup);

    const map = group.createMap();
    map.set("hello", "world");

    await map.core.waitForSync();

    const mapOnServer = await loadCoValueOrFail(jazzCloud.node, map.id);
    expect(mapOnServer.get("hello")).toEqual("world");

    expect(
      SyncMessagesLog.getMessages({
        ParentGroup: parentGroup.core,
        Group: group.core,
        Map: map.core,
      }),
    ).toMatchInlineSnapshot(`
      [
        "client -> server | CONTENT Group header: true new: After: 0 New: 4",
        "client -> server | CONTENT ParentGroup header: true new: After: 0 New: 6",
        "client -> server | CONTENT Group header: false new: After: 4 New: 2",
        "client -> server | CONTENT Map header: true new: After: 0 New: 1",
        "server -> client | KNOWN Group sessions: header/4",
        "server -> client | KNOWN ParentGroup sessions: header/6",
        "server -> client | KNOWN Group sessions: header/6",
        "server -> client | KNOWN Map sessions: header/1",
      ]
    `);
  });

  test("coValue uploading with a missing dependency", async () => {
    const client = setupTestNode({
      connected: true,
    });

    const group = client.node.createGroup();
    const map = group.createMap();
    map.set("hello", "world", "trusting");

    await group.core.waitForSync();
    await map.core.waitForSync();

    map.set("hello", "new world", "trusting");
    // Testing that with a missing group the sync will not fail
    client.node.internalDeleteCoValue(group.id);

    await map.core.waitForSync();

    const mapOnServer = await loadCoValueOrFail(jazzCloud.node, map.id);
    expect(mapOnServer.get("hello")).toEqual("new world");

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
        "server -> client | KNOWN Map sessions: header/1",
        "client -> server | CONTENT Map header: false new: After: 1 New: 1",
        "server -> client | KNOWN Map sessions: header/2",
      ]
    `);
  });

  test("wrong optimistic known state should be corrected", async () => {
    const client = setupTestNode({
      connected: true,
    });

    const group = client.node.createGroup();
    group.addMember("everyone", "writer");

    const map = group.createMap({
      fromServer: "initial",
      fromClient: "initial",
    });

    // Load the coValue on the client
    await map.core.waitForSync();

    // Forcefully delete the coValue from the client (simulating some data loss)
    jazzCloud.node.internalDeleteCoValue(map.id);

    map.set("fromClient", "updated", "trusting");

    await waitFor(() => {
      const coValue = expectMap(
        jazzCloud.node.expectCoValueLoaded(map.id).getCurrentContent(),
      );
      expect(coValue.get("fromClient")).toEqual("updated");
    });

    expect(
      SyncMessagesLog.getMessages({
        Group: group.core,
        Map: map.core,
      }),
    ).toMatchInlineSnapshot(`
      [
        "client -> server | CONTENT Group header: true new: After: 0 New: 6",
        "client -> server | CONTENT Map header: true new: After: 0 New: 1",
        "server -> client | KNOWN Group sessions: header/6",
        "server -> client | KNOWN Map sessions: header/1",
        "client -> server | CONTENT Map header: false new: After: 1 New: 1",
        "server -> client | KNOWN CORRECTION Map sessions: empty",
        "client -> server | CONTENT Map header: true new: After: 0 New: 2",
        "server -> client | KNOWN Map sessions: header/2",
      ]
    `);
  });

  test("syncing changes between two clients with a sync server in the middle", async () => {
    const client = setupTestNode({
      connected: true,
    });
    const otherClient = setupTestNode({});

    const otherClientConnection = otherClient.connectToSyncServer({
      ourName: "otherClient",
    });

    const coValue = client.node.createCoValue({
      type: "colist",
      ruleset: { type: "unsafeAllowAll" },
      meta: null,
      ...Crypto.createdNowUnique(),
    });

    const list = expectList(coValue.getCurrentContent());

    list.append(1, undefined, "trusting");

    const listOnOtherClient = await loadCoValueOrFail(
      otherClient.node,
      list.id,
    );

    otherClientConnection.peerState.gracefulShutdown();

    listOnOtherClient.append(1, undefined, "trusting");

    await new Promise((resolve) => setTimeout(resolve, 50));

    list.append(1, undefined, "trusting");

    await new Promise((resolve) => setTimeout(resolve, 50));

    listOnOtherClient.append(1, undefined, "trusting");

    await new Promise((resolve) => setTimeout(resolve, 50));

    list.append(1, undefined, "trusting");

    otherClient.connectToSyncServer({
      ourName: "otherClient",
    });

    await waitFor(() => {
      expect(list.toJSON()).toEqual([1, 1, 1, 1, 1]);
    });

    expect(
      SyncMessagesLog.getMessages({
        Colist: coValue,
      }),
    ).toMatchInlineSnapshot(`
      [
        "otherClient -> server | LOAD Colist sessions: empty",
        "client -> server | CONTENT Colist header: true new: After: 0 New: 1",
        "server -> otherClient | KNOWN Colist sessions: empty",
        "server -> client | KNOWN Colist sessions: header/1",
        "server -> otherClient | CONTENT Colist header: true new: After: 0 New: 1",
        "otherClient -> server | KNOWN Colist sessions: header/1",
        "client -> server | CONTENT Colist header: false new: After: 1 New: 1",
        "server -> client | KNOWN Colist sessions: header/2",
        "server -> otherClient | CONTENT Colist header: false new: After: 1 New: 1",
        "otherClient -> server | LOAD Colist sessions: header/3",
        "client -> server | CONTENT Colist header: false new: After: 2 New: 1",
        "server -> otherClient | CONTENT Colist header: false new: After: 1 New: 1",
        "server -> client | KNOWN Colist sessions: header/3",
        "server -> otherClient | CONTENT Colist header: false new: After: 2 New: 1",
        "otherClient -> server | KNOWN Colist sessions: header/4",
        "otherClient -> server | CONTENT Colist header: false new: After: 0 New: 2",
        "otherClient -> server | KNOWN Colist sessions: header/5",
        "server -> otherClient | KNOWN Colist sessions: header/5",
        "server -> client | CONTENT Colist header: false new: After: 0 New: 2",
        "client -> server | KNOWN Colist sessions: header/5",
      ]
    `);
  });

  test("local updates batching", async () => {
    const client = setupTestNode({
      connected: true,
    });

    const group = client.node.createGroup();
    const initialMap = group.createMap();

    const child = group.createMap();
    child.set("parent", initialMap.id);
    initialMap.set("child", child.id);

    await initialMap.core.waitForSync();

    expect(
      SyncMessagesLog.getMessages({
        Group: group.core,
        InitialMap: initialMap.core,
        ChildMap: child.core,
      }),
    ).toMatchInlineSnapshot(`
      [
        "client -> server | CONTENT Group header: true new: After: 0 New: 4",
        "client -> server | CONTENT InitialMap header: true new: ",
        "client -> server | CONTENT ChildMap header: true new: After: 0 New: 1",
        "client -> server | CONTENT InitialMap header: false new: After: 0 New: 1",
        "server -> client | KNOWN Group sessions: header/4",
        "server -> client | KNOWN InitialMap sessions: header/0",
        "server -> client | KNOWN ChildMap sessions: header/1",
        "server -> client | KNOWN InitialMap sessions: header/1",
      ]
    `);
  });

  test("large coValue upload streaming", async () => {
    const client = setupTestNode({
      connected: true,
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
        "client -> server | CONTENT Group header: true new: After: 0 New: 6",
        "client -> server | CONTENT Map header: true new: After: 0 New: 73 expectContentUntil: header/200",
        "client -> server | CONTENT Map header: false new: After: 73 New: 73",
        "client -> server | CONTENT Map header: false new: After: 146 New: 54",
        "server -> client | KNOWN Group sessions: header/6",
        "server -> client | KNOWN Map sessions: header/73",
        "server -> client | KNOWN Map sessions: header/146",
        "server -> client | KNOWN Map sessions: header/200",
      ]
    `);
  });

  test("uploading a large update", async () => {
    const client = setupTestNode({
      connected: true,
    });

    const group = client.node.createGroup();
    group.addMember("everyone", "writer");

    const largeMap = group.createMap();

    await largeMap.core.waitForSync();

    fillCoMapWithLargeData(largeMap);

    await largeMap.core.waitForSync();

    expect(
      SyncMessagesLog.getMessages({
        Group: group.core,
        Map: largeMap.core,
      }),
    ).toMatchInlineSnapshot(`
      [
        "client -> server | CONTENT Group header: true new: After: 0 New: 6",
        "client -> server | CONTENT Map header: true new: ",
        "client -> server | CONTENT Map header: false new: After: 0 New: 73 expectContentUntil: header/200",
        "client -> server | CONTENT Map header: false new: After: 73 New: 73",
        "client -> server | CONTENT Map header: false new: After: 146 New: 54",
        "server -> client | KNOWN Group sessions: header/6",
        "server -> client | KNOWN Map sessions: header/0",
        "server -> client | KNOWN Map sessions: header/73",
        "server -> client | KNOWN Map sessions: header/146",
        "server -> client | KNOWN Map sessions: header/200",
      ]
    `);
  });

  test("uploading a coValue with a non-matching header", async () => {
    const client = setupTestNode({
      connected: false,
    });

    const coValue = client.node.createCoValue({
      type: "comap",
      ruleset: { type: "unsafeAllowAll" },
      meta: null,
      ...Crypto.createdNowUnique(),
    });

    const map = coValue.getCurrentContent() as RawCoMap;
    map.set("hello", "world", "trusting");

    const content = map.core.newContentSince(undefined)?.[0];
    assert(content);

    // Simulate a mismatch between the header and the coValue id
    content.id = "co_ztest123";

    jazzCloud.node.syncManager.handleNewContent(content, "import");

    expect(jazzCloud.node.getCoValue(content.id).isAvailable()).toBe(false);
  });
});
