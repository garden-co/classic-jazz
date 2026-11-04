import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { expectMap } from "../coValue.js";
import { RawCoMap } from "../coValues/coMap.js";
import { WasmCrypto } from "../crypto/WasmCrypto.js";
import { connectedPeers, newQueuePair } from "../streamUtils.js";
import type { LoadMessage } from "../sync.js";
import {
  TEST_NODE_CONFIG,
  blockMessageTypeOnOutgoingPeer,
  connectTwoPeers,
  createTestMetricReader,
  createTestNode,
  loadCoValueOrFail,
  nodeWithRandomAgentAndSessionID,
  randomAgentAndSessionID,
  setupTestAccount,
  setupTestNode,
  tearDownTestMetricReader,
  waitFor,
} from "./testUtils.js";
import { Stringified } from "../jsonStringify.js";
import { JsonValue } from "../jsonValue.js";

// We want to simulate a real world communication that happens asynchronously
TEST_NODE_CONFIG.withAsyncPeers = true;

const Crypto = await WasmCrypto.create();

let jazzCloud: ReturnType<typeof setupTestNode>;

beforeEach(async () => {
  jazzCloud = setupTestNode({
    isSyncServer: true,
  });
});

test("If we add a client peer, but it never subscribes to a coValue, it won't get any messages", async () => {
  const node = nodeWithRandomAgentAndSessionID();

  const group = node.createGroup();

  const map = group.createMap();

  const [inRx] = newQueuePair();
  const [, outTx] = newQueuePair();

  node.syncManager.addPeer({
    id: "test",
    incoming: inRx,
    outgoing: outTx,
    role: "client",
  });

  map.set("hello", "world", "trusting");

  const timeoutPromise = new Promise((resolve) =>
    setTimeout(() => resolve("neverHappened"), 100),
  );

  const result = await Promise.race([
    new Promise((resolve) => {
      inRx.onMessage((msg) => resolve(msg));
    }),
    timeoutPromise,
  ]);

  expect(result).toEqual("neverHappened");
});

test("Can sync a coValue through a server to another client", async () => {
  const { node: client1 } = await setupTestAccount({
    connected: true,
  });

  const group = client1.createGroup();

  const map = group.createMap();
  map.set("hello", "world", "trusting");

  const { node: client2 } = await setupTestAccount({
    connected: true,
  });

  const mapOnClient2 = await loadCoValueOrFail(client2, map.id);

  expect(mapOnClient2.get("hello")).toEqual("world");
});

test("Can sync a coValue with private transactions through a server to another client", async () => {
  const { node: client1 } = await setupTestAccount({
    connected: true,
  });

  const group = client1.createGroup();

  const map = group.createMap();
  map.set("hello", "world", "private");

  group.addMember("everyone", "reader");

  const { node: client2 } = await setupTestAccount({
    connected: true,
  });

  await waitFor(async () => {
    const loadedMap = await loadCoValueOrFail(client2, map.id);

    expect(loadedMap.get("hello")).toEqual("world");
  });
});

test("should keep the peer state when the peer closes if persistent is true", async () => {
  const client = setupTestNode();

  const { peer, peerState, peerOnServer } = client.connectToSyncServer({
    persistent: true,
  });

  const group = jazzCloud.node.createGroup();
  const map = group.createMap();
  map.set("hello", "world", "trusting");

  await client.node.loadCoValueCore(map.core.id);

  const syncManager = client.node.syncManager;

  peerOnServer.outgoing.push("Disconnected");

  await waitFor(() => {
    return peerState.closed;
  });

  expect(syncManager.peers[peer.id]).not.toBeUndefined();
});

test("should delete the peer state when the peer closes if persistent is false", async () => {
  const client = setupTestNode();

  const { peer, peerState, peerOnServer } = client.connectToSyncServer({
    persistent: false,
  });

  const group = jazzCloud.node.createGroup();
  const map = group.createMap();
  map.set("hello", "world", "trusting");

  await client.node.loadCoValueCore(map.core.id);

  const syncManager = client.node.syncManager;

  peerOnServer.outgoing.push("Disconnected");

  await waitFor(() => peerState?.closed);

  expect(syncManager.peers[peer.id]).toBeUndefined();
});

test("should not verify transactions when SyncManager has verification disabled", async () => {
  jazzCloud.node.syncManager.disableTransactionVerification();

  const [agent] = randomAgentAndSessionID();
  const client = await setupTestAccount({ connected: true });

  const group = client.node.createGroup();
  const map = group.createMap();

  map.core.tryAddTransactions(
    client.node.currentSessionID,
    [
      {
        privacy: "trusting",
        changes: JSON.stringify([
          { op: "set", key: "hello", value: "world" },
        ]) as Stringified<JsonValue[]>,
        madeAt: Date.now(),
      },
    ],
    Crypto.sign(agent.currentSignerSecret(), "hash_z12345678"),
    true,
  );

  await map.core.waitForSync();

  const loadedMap = await loadCoValueOrFail(jazzCloud.node, map.id);
  expect(loadedMap.get("hello")).toEqual("world");
});

describe("sync - extra tests", () => {
  test("Node handles disconnection and reconnection of a peer gracefully", async () => {
    // Create two nodes
    const node1 = nodeWithRandomAgentAndSessionID();
    const node2 = nodeWithRandomAgentAndSessionID();

    // Create a group and a map on node1
    const group = node1.createGroup();
    group.addMember("everyone", "writer");
    const map = group.createMap();
    map.set("key1", "value1", "trusting");

    // Connect the nodes
    const [node1AsPeer, node2AsPeer] = connectedPeers("node1", "node2", {
      peer1role: "server",
      peer2role: "client",
    });

    node1.syncManager.addPeer(node2AsPeer);
    node2.syncManager.addPeer(node1AsPeer);

    // Wait for initial sync
    await new Promise((resolve) => setTimeout(resolve, 100));

    // Verify that node2 has received the map
    const mapOnNode2 = await node2.loadCoValueCore(map.core.id);
    if (!mapOnNode2.isAvailable()) {
      throw new Error("Map is unavailable on node2");
    }

    expect(expectMap(mapOnNode2.getCurrentContent()).get("key1")).toEqual(
      "value1",
    );

    // Simulate disconnection
    node1.syncManager.gracefulShutdown();
    node2.syncManager.gracefulShutdown();

    // Make changes on node1 while disconnected
    map.set("key2", "value2", "trusting");

    // Simulate reconnection
    const [newNode1AsPeer, newNode2AsPeer] = connectedPeers(
      "node11",
      "node22",
      {
        peer1role: "server",
        peer2role: "client",
        // trace: true,
      },
    );

    node1.syncManager.addPeer(newNode2AsPeer);
    node2.syncManager.addPeer(newNode1AsPeer);

    // Wait for re-sync
    await new Promise((resolve) => setTimeout(resolve, 100));

    // Verify that node2 has received the changes made during disconnection
    const updatedMapOnNode2 = await node2.loadCoValueCore(map.core.id);
    if (!updatedMapOnNode2.isAvailable()) {
      throw new Error("Updated map is unavailable on node2");
    }

    expect(
      expectMap(updatedMapOnNode2.getCurrentContent()).get("key2"),
    ).toEqual("value2");

    // Make a new change on node2 to verify two-way sync
    const mapOnNode2ForEdit = await node2.loadCoValueCore(map.core.id);
    if (!mapOnNode2ForEdit.isAvailable()) {
      throw new Error("Updated map is unavailable on node2");
    }

    const success = mapOnNode2ForEdit.makeTransaction(
      [
        {
          op: "set",
          key: "key3",
          value: "value3",
        },
      ],
      "trusting",
    );

    if (!success) {
      throw new Error("Failed to make transaction");
    }

    // Wait for sync back to node1
    await new Promise((resolve) => setTimeout(resolve, 100));

    const mapOnNode1 = await node1.loadCoValueCore(map.core.id);
    if (!mapOnNode1.isAvailable()) {
      throw new Error("Updated map is unavailable on node1");
    }

    // Verify that node1 has received the change from node2
    expect(expectMap(mapOnNode1.getCurrentContent()).get("key3")).toEqual(
      "value3",
    );
  });
  test("Concurrent modifications on multiple nodes are resolved correctly", async () => {
    // Create three nodes
    const node1 = nodeWithRandomAgentAndSessionID();
    const node2 = nodeWithRandomAgentAndSessionID();
    const node3 = nodeWithRandomAgentAndSessionID();

    // Create a group and a map on node1
    const group = node1.createGroup();
    group.addMember("everyone", "writer");
    const map = group.createMap();

    // Connect the nodes in a triangle topology
    const [node1AsPeerFor2, node2AsPeerFor1] = connectedPeers(
      "node1",
      "node2",
      {
        peer1role: "server",
        peer2role: "client",
        // trace: true,
      },
    );

    const [node2AsPeerFor3, node3AsPeerFor2] = connectedPeers(
      "node2",
      "node3",
      {
        peer1role: "server",
        peer2role: "client",
        // trace: true,
      },
    );

    const [node3AsPeerFor1, node1AsPeerFor3] = connectedPeers(
      "node3",
      "node1",
      {
        peer1role: "server",
        peer2role: "client",
        // trace: true,
      },
    );

    node1.syncManager.addPeer(node2AsPeerFor1);
    node1.syncManager.addPeer(node3AsPeerFor1);
    node2.syncManager.addPeer(node1AsPeerFor2);
    node2.syncManager.addPeer(node3AsPeerFor2);
    node3.syncManager.addPeer(node1AsPeerFor3);
    node3.syncManager.addPeer(node2AsPeerFor3);

    // Wait for initial sync
    await new Promise((resolve) => setTimeout(resolve, 100));

    // Verify that all nodes have the map
    const mapOnNode1 = await node1.loadCoValueCore(map.core.id);
    const mapOnNode2 = await node2.loadCoValueCore(map.core.id);
    const mapOnNode3 = await node3.loadCoValueCore(map.core.id);

    if (
      !mapOnNode1.isAvailable() ||
      !mapOnNode2.isAvailable() ||
      !mapOnNode3.isAvailable()
    ) {
      throw new Error("Map is unavailable on node2 or node3");
    }

    // Perform concurrent modifications
    map.set("key1", "value1", "trusting");
    new RawCoMap(mapOnNode2).set("key2", "value2", "trusting");
    new RawCoMap(mapOnNode3).set("key3", "value3", "trusting");

    // Wait for sync to complete
    await new Promise((resolve) => setTimeout(resolve, 200));

    // Verify that all nodes have the same final state
    const finalStateNode1 = expectMap(mapOnNode1.getCurrentContent());
    const finalStateNode2 = expectMap(mapOnNode2.getCurrentContent());
    const finalStateNode3 = expectMap(mapOnNode3.getCurrentContent());

    const expectedState = {
      key1: "value1",
      key2: "value2",
      key3: "value3",
    };

    expect(finalStateNode1.toJSON()).toEqual(expectedState);
    expect(finalStateNode2.toJSON()).toEqual(expectedState);
    expect(finalStateNode3.toJSON()).toEqual(expectedState);
  });

  test("Node correctly handles and recovers from network partitions", async () => {
    // Create three nodes
    const node1 = nodeWithRandomAgentAndSessionID();
    const node2 = nodeWithRandomAgentAndSessionID();
    const node3 = nodeWithRandomAgentAndSessionID();

    // Create a group and a map on node1
    const group = node1.createGroup();
    group.addMember("everyone", "writer");
    const map = group.createMap();
    map.set("initial", "value", "trusting");

    // Connect all nodes
    const [node1AsPeerFor2, node2AsPeerFor1] = connectedPeers(
      "node1",
      "node2",
      {
        peer1role: "server",
        peer2role: "client",
        // trace: true,
      },
    );

    const [node2AsPeerFor3, node3AsPeerFor2] = connectedPeers(
      "node2",
      "node3",
      {
        peer1role: "server",
        peer2role: "client",
        // trace: true,
      },
    );

    const [node3AsPeerFor1, node1AsPeerFor3] = connectedPeers(
      "node3",
      "node1",
      {
        peer1role: "server",
        peer2role: "client",
        // trace: true,
      },
    );

    node1.syncManager.addPeer(node2AsPeerFor1);
    node1.syncManager.addPeer(node3AsPeerFor1);
    node2.syncManager.addPeer(node1AsPeerFor2);
    node2.syncManager.addPeer(node3AsPeerFor2);
    node3.syncManager.addPeer(node1AsPeerFor3);
    node3.syncManager.addPeer(node2AsPeerFor3);

    // Wait for initial sync
    await new Promise((resolve) => setTimeout(resolve, 100));

    // Verify initial state
    const mapOnNode1Core = await node1.loadCoValueCore(map.core.id);
    const mapOnNode2Core = await node2.loadCoValueCore(map.core.id);
    const mapOnNode3Core = await node3.loadCoValueCore(map.core.id);

    if (
      !mapOnNode1Core.isAvailable() ||
      !mapOnNode2Core.isAvailable() ||
      !mapOnNode3Core.isAvailable()
    ) {
      throw new Error("Map is unavailable on node2 or node3");
    }

    // const mapOnNode1 = new RawCoMap(mapOnNode1Core);
    const mapOnNode2 = new RawCoMap(mapOnNode2Core);
    const mapOnNode3 = new RawCoMap(mapOnNode3Core);

    expect(mapOnNode2.get("initial")).toBe("value");
    expect(mapOnNode3.get("initial")).toBe("value");

    // Simulate network partition: disconnect node3 from node1 and node2
    node1.syncManager.peers["node3"]?.gracefulShutdown();
    delete node1.syncManager.peers["node3"];
    node2.syncManager.peers["node3"]?.gracefulShutdown();
    delete node2.syncManager.peers["node3"];
    node3.syncManager.peers["node1"]?.gracefulShutdown();
    delete node3.syncManager.peers["node1"];
    node3.syncManager.peers["node2"]?.gracefulShutdown();
    delete node3.syncManager.peers["node2"];

    // Make changes on both sides of the partition
    map.set("node1", "partition", "trusting");
    mapOnNode2.set("node2", "partition", "trusting");
    mapOnNode3.set("node3", "partition", "trusting");

    // Wait for sync between node1 and node2
    await new Promise((resolve) => setTimeout(resolve, 100));

    // Verify that node1 and node2 are in sync, but node3 is not
    expect(expectMap(mapOnNode1Core.getCurrentContent()).get("node1")).toBe(
      "partition",
    );
    expect(expectMap(mapOnNode1Core.getCurrentContent()).get("node2")).toBe(
      "partition",
    );
    expect(expectMap(mapOnNode1Core.getCurrentContent()).toJSON()?.node3).toBe(
      undefined,
    );

    expect(expectMap(mapOnNode2Core.getCurrentContent()).get("node1")).toBe(
      "partition",
    );
    expect(expectMap(mapOnNode2Core.getCurrentContent()).get("node2")).toBe(
      "partition",
    );
    expect(expectMap(mapOnNode2Core.getCurrentContent()).toJSON()?.node3).toBe(
      undefined,
    );

    expect(expectMap(mapOnNode3Core.getCurrentContent()).toJSON()?.node1).toBe(
      undefined,
    );
    expect(expectMap(mapOnNode3Core.getCurrentContent()).toJSON()?.node2).toBe(
      undefined,
    );

    expect(expectMap(mapOnNode3Core.getCurrentContent()).toJSON()?.node3).toBe(
      "partition",
    );

    // Restore connectivity
    const [newNode3AsPeerFor1, newNode1AsPeerFor3] = connectedPeers(
      "node3",
      "node1",
      {
        peer1role: "server",
        peer2role: "client",
        // trace: true,
      },
    );

    const [newNode3AsPeerFor2, newNode2AsPeerFor3] = connectedPeers(
      "node3",
      "node2",
      {
        peer1role: "server",
        peer2role: "client",
        // trace: true,
      },
    );

    node1.syncManager.addPeer(newNode3AsPeerFor1);
    node2.syncManager.addPeer(newNode3AsPeerFor2);
    node3.syncManager.addPeer(newNode1AsPeerFor3);
    node3.syncManager.addPeer(newNode2AsPeerFor3);

    // Wait for re-sync
    await new Promise((resolve) => setTimeout(resolve, 200));

    // Verify final state: all nodes should have all changes
    const finalStateNode1 = expectMap(
      mapOnNode1Core.getCurrentContent(),
    ).toJSON();
    const finalStateNode2 = expectMap(
      mapOnNode2Core.getCurrentContent(),
    ).toJSON();
    const finalStateNode3 = expectMap(
      mapOnNode3Core.getCurrentContent(),
    ).toJSON();

    const expectedFinalState = {
      initial: "value",
      node1: "partition",
      node2: "partition",
      node3: "partition",
    };

    expect(finalStateNode1).toEqual(expectedFinalState);
    expect(finalStateNode2).toEqual(expectedFinalState);
    expect(finalStateNode3).toEqual(expectedFinalState);
  });
});

test("a value created on one node can be loaded on another node even if not directly connected", async () => {
  const userA = createTestNode();
  const userB = createTestNode();
  const serverA = createTestNode();
  const serverB = createTestNode();
  const core = createTestNode();

  connectTwoPeers(userA, serverA, "client", "server");
  connectTwoPeers(userB, serverB, "client", "server");
  connectTwoPeers(serverA, core, "client", "server");
  connectTwoPeers(serverB, core, "client", "server");

  const group = userA.createGroup();
  const map = group.createMap();
  map.set("key1", "value1", "trusting");

  await map.core.waitForSync();

  const mapOnUserB = await loadCoValueOrFail(userB, map.id);
  expect(mapOnUserB.get("key1")).toBe("value1");

  map.set("key2", "value2", "trusting");

  await waitFor(() => {
    expect(mapOnUserB.get("key2")).toBe("value2");
  });
});

describe("SyncManager - knownStates vs optimisticKnownStates", () => {
  test("knownStates and optimisticKnownStates are the same when the coValue is fully synced", async () => {
    const { node: client } = await setupTestAccount({
      connected: true,
    });

    // Create test data
    const group = client.createGroup();
    const mapOnClient = group.createMap();
    mapOnClient.set("key1", "value1", "trusting");

    // Wait for the full sync to complete
    await mapOnClient.core.waitForSync();

    const peerStateClient = client.syncManager.getPeers(
      mapOnClient.core.id,
    )[0]!;
    const peerStateJazzCloud = jazzCloud.node.syncManager.getPeers(
      mapOnClient.core.id,
    )[0]!;

    // The optimisticKnownStates should be the same as the knownStates after the full sync is complete
    expect(
      peerStateClient.getOptimisticKnownState(mapOnClient.core.id),
    ).toEqual(peerStateClient.getKnownState(mapOnClient.core.id));

    // On the other node the knownStates should be updated correctly based on the messages we received
    expect(
      peerStateJazzCloud.getOptimisticKnownState(mapOnClient.core.id),
    ).toEqual(peerStateJazzCloud.getKnownState(mapOnClient.core.id));
  });

  test("optimisticKnownStates is updated as new transactions are sent, while knownStates only when the updates are acknowledged", async () => {
    const client = await setupTestAccount();

    const { peer, peerState } = client.connectToSyncServer();

    // Create test data and sync the first change
    // We want that both the nodes know about the coValue so we can test
    // the content acknowledgement flow.
    const group = client.node.createGroup();
    const map = group.createMap();
    map.set("key1", "value1", "trusting");

    await map.core.waitForSync();

    // Block the content messages
    // The main difference between optimisticKnownStates and knownStates is that
    // optimisticKnownStates is updated when the content messages are sent,
    // while knownStates is only updated when we receive the "known" messages
    // that are acknowledging the receipt of the content messages
    const outgoing = blockMessageTypeOnOutgoingPeer(peer, "content", {});

    map.set("key2", "value2", "trusting");

    await new Promise<void>(queueMicrotask);

    expect(peerState.getOptimisticKnownState(map.core.id)).not.toEqual(
      peerState.getKnownState(map.core.id),
    );

    // Restore the implementation of push and send the blocked messages
    // After this the full sync can be completed and the other node will
    // respond with a "known" message acknowledging the receipt of the content messages
    outgoing.unblock();
    await outgoing.sendBlockedMessages();

    await map.core.waitForSync();

    expect(peerState.getOptimisticKnownState(map.core.id)).toEqual(
      peerState.getKnownState(map.core.id),
    );
  });
});

describe("SyncManager.addPeer", () => {
  test("new peer with new ID starts with empty knownStates", async () => {
    const client = await setupTestAccount({
      connected: true,
    });

    // Create test data
    const group = client.node.createGroup();
    const map = group.createMap();
    map.set("key1", "value1", "trusting");

    // Wait for initial sync
    await map.core.waitForSync();

    // Connect second peer with different ID
    const [brandNewPeer] = connectedPeers("brandNewPeer", "unusedPeer", {
      peer1role: "client",
      peer2role: "server",
    });

    // Add new peer with different ID
    client.node.syncManager.addPeer(brandNewPeer);

    // Verify that the new peer starts with empty known states
    const newPeerState = client.node.syncManager.peers["brandNewPeer"];
    expect(newPeerState?.getKnownState(map.core.id)).toBe(undefined);
  });

  test("when adding a peer with the same ID as a previous peer, the previous peer is closed", async () => {
    const client = await setupTestAccount({});

    const { peerState: firstPeerState } = client.connectToSyncServer();

    // Store reference to first peer
    const closeSpy = vi.spyOn(firstPeerState, "gracefulShutdown");

    // Create and add replacement peer
    const [secondPeer] = connectedPeers(firstPeerState.id, "unusedPeer", {
      peer1role: "server",
      peer2role: "client",
    });

    client.node.syncManager.addPeer(secondPeer);

    // Verify thet the first peer had ben closed correctly
    expect(closeSpy).toHaveBeenCalled();
    expect(firstPeerState.closed).toBe(true);
  });

  test("when adding a peer with the same ID as a previous peer and the previous peer is closed, do not attempt to close it again", async () => {
    const client = await setupTestAccount({
      connected: true,
    });

    // Store reference to first peer
    const { peerState: firstPeerState } = client.connectToSyncServer();

    firstPeerState.gracefulShutdown();
    const closeSpy = vi.spyOn(firstPeerState, "gracefulShutdown");

    // Create and add replacement peer
    const [secondPeer] = connectedPeers(firstPeerState.id, "unusedPeer", {
      peer1role: "server",
      peer2role: "client",
    });

    client.node.syncManager.addPeer(secondPeer);

    // Verify thet the first peer had not been closed again
    expect(closeSpy).not.toHaveBeenCalled();
    expect(firstPeerState.closed).toBe(true);
  });

  test("when adding a server peer the local coValues should be sent to it", async () => {
    const client = await setupTestAccount({
      connected: false,
    });

    const group = client.node.createGroup();
    const map = group.createMap();
    map.set("key1", "value1", "trusting");

    client.connectToSyncServer();

    await map.core.waitForSync();

    expect(jazzCloud.node.getCoValue(map.id).isAvailable()).toBe(true);
  });
});

describe("loadCoValueCore with retry", () => {
  test("should load the value if available on the server", async () => {
    const client = await setupTestAccount({
      connected: true,
    });

    const anotherClient = await setupTestAccount({
      connected: true,
    });

    const group = anotherClient.node.createGroup();
    const map = group.createMap();
    map.set("key1", "value1", "trusting");

    const promise = client.node.loadCoValueCore(map.id);

    await expect(promise).resolves.not.toBe("unavailable");
  });

  test("should handle correctly two subsequent loads", async () => {
    const client = await setupTestAccount({
      connected: true,
    });

    const anotherClient = await setupTestAccount({
      connected: true,
    });

    const group = anotherClient.node.createGroup();
    const map = group.createMap();
    map.set("key1", "value1", "trusting");

    const promise1 = client.node.loadCoValueCore(map.id);
    const promise2 = client.node.loadCoValueCore(map.id);

    await expect(promise1).resolves.not.toBe("unavailable");
    await expect(promise2).resolves.not.toBe("unavailable");
  });

  test("should load unavailable coValues after they are synced", async () => {
    const bob = createTestNode();
    const alice = createTestNode();

    // Create a group and map on anotherClient
    const group = alice.createGroup();
    const map = group.createMap();
    map.set("key1", "value1", "trusting");

    // Start loading before syncing
    const result = await bob.loadCoValueCore(map.id);

    expect(result.isAvailable()).toBe(false);

    connectTwoPeers(alice, bob, "server", "server");

    const result2 = await bob.loadCoValueCore(map.id);

    expect(result2.isAvailable()).toBe(true);
  });

  test("should successfully mark a coValue as unavailable if the server does not have it", async () => {
    const bob = createTestNode();
    const alice = createTestNode();
    const charlie = createTestNode();

    connectTwoPeers(bob, charlie, "client", "server");

    // Create a group and map on anotherClient
    const group = alice.createGroup();
    const map = group.createMap();
    map.set("key1", "value1", "trusting");

    // Start loading before syncing
    const result = await bob.loadCoValueCore(map.id);

    expect(result.isAvailable()).toBe(false);
  });
});

describe("SyncManager.removePeer", () => {
  test("when removing a peer, the peer is closed", async () => {
    const client = await setupTestAccount();

    const { peerState } = client.connectToSyncServer();

    // Store reference to peer and spy on gracefulShutdown
    const closeSpy = vi.spyOn(peerState, "gracefulShutdown");

    // Remove the peer
    client.node.syncManager.removePeer(peerState.id);

    // Verify that the peer was closed correctly
    expect(closeSpy).toHaveBeenCalled();
    expect(peerState.closed).toBe(true);

    // Verify that the peer is no longer in the peers map
    expect(client.node.syncManager.peers[peerState.id]).toBeUndefined();
  });
});

describe("waitForSyncWithPeer", () => {
  test("should resolve when the coValue is fully uploaded into the peer", async () => {
    const client = await setupTestAccount();

    const { peerState } = client.connectToSyncServer();

    // Create test data
    const group = client.node.createGroup();
    const map = group.createMap();
    map.set("key1", "value1", "trusting");

    await expect(
      client.node.syncManager.waitForSyncWithPeer(
        peerState.id,
        map.core.id,
        100,
      ),
    ).resolves.toBe(true);
  });

  test("should not resolve when the coValue is not synced", async () => {
    const client = await setupTestAccount();

    const { peerState } = client.connectToSyncServer();

    // Create test data
    const group = client.node.createGroup();
    const map = group.createMap();
    map.set("key1", "value1", "trusting");

    vi.spyOn(peerState, "pushOutgoingMessage").mockImplementation(async () => {
      return Promise.resolve();
    });

    await expect(
      client.node.syncManager.waitForSyncWithPeer(
        peerState.id,
        map.core.id,
        100,
      ),
    ).rejects.toThrow("Timeout");
  });

  test("should resolve when local ingestion catches up with the peer known state", async () => {
    const receiver = nodeWithRandomAgentAndSessionID();
    const { syncManager } = receiver;
    const group = jazzCloud.node.createGroup();
    const map = group.createMap();
    map.set("key1", "value1", "trusting");

    const groupContent = group.core.newContentSince(undefined)![0]!;
    const firstContent = map.core.newContentSince(undefined)![0]!;
    syncManager.handleNewContent(groupContent, "import");
    syncManager.handleNewContent(firstContent, "import");

    const [peer] = connectedPeers("sender", "receiver");
    syncManager.addPeer(peer);
    const peerState = syncManager.peers["sender"]!;

    map.set("key2", "value2", "trusting");
    peerState.combineWith(map.id, map.core.knownState());
    expect(syncManager.syncState.isSynced(peerState, map.id)).toBe(false);

    const content = map.core.newContentSince(
      receiver.expectCoValueLoaded(map.id).knownState(),
    )![0]!;
    const wait = syncManager.waitForSyncWithPeer("sender", map.id, 100);
    syncManager.handleNewContent(content, "import");

    await expect(wait).resolves.toBe(true);
  });
});

test("Should not crash when syncing an unknown coValue type", async () => {
  const client = await setupTestAccount({
    connected: true,
  });

  const coValue = client.node.createCoValue({
    type: "ooops" as any,
    ruleset: { type: "unsafeAllowAll" },
    meta: null,
    ...Crypto.createdNowUnique(),
  });

  await coValue.waitForSync();

  const anotherClient = await setupTestAccount({
    connected: true,
  });

  const coValueOnTheOtherNode = await loadCoValueOrFail(
    anotherClient.node,
    coValue.getCurrentContent().id,
  );
  expect(coValueOnTheOtherNode.id).toBe(coValue.id);
});

describe("metrics", () => {
  afterEach(() => {
    tearDownTestMetricReader();
  });

  test("should correctly track the number of connected peers", async () => {
    const metricReader = createTestMetricReader();
    const node = nodeWithRandomAgentAndSessionID();

    let connectedPeers = await metricReader.getMetricValue("jazz.peers", {
      role: "client",
    });
    expect(connectedPeers).toBeUndefined();
    let connectedServerPeers = await metricReader.getMetricValue("jazz.peers", {
      role: "server",
    });
    expect(connectedServerPeers).toBeUndefined();

    // Add a first peer
    const [inPeer1, outPeer1] = newQueuePair();
    node.syncManager.addPeer({
      id: "peer-1",
      incoming: inPeer1,
      outgoing: outPeer1,
      role: "client",
    });

    connectedPeers = await metricReader.getMetricValue("jazz.peers", {
      role: "client",
    });
    expect(connectedPeers).toBe(1);

    // Add another peer
    const [inPeer2, outPeer2] = newQueuePair();
    node.syncManager.addPeer({
      id: "peer-2",
      incoming: inPeer2,
      outgoing: outPeer2,
      role: "client",
    });

    connectedPeers = await metricReader.getMetricValue("jazz.peers", {
      role: "client",
    });
    expect(connectedPeers).toBe(2);

    // Add a server peer
    const [inServer1, outServer1] = newQueuePair();
    node.syncManager.addPeer({
      id: "server-1",
      incoming: inServer1,
      outgoing: outServer1,
      role: "server",
    });
    connectedServerPeers = await metricReader.getMetricValue("jazz.peers", {
      role: "server",
    });
    expect(connectedServerPeers).toBe(1);
    connectedPeers = await metricReader.getMetricValue("jazz.peers", {
      role: "client",
    });
    expect(connectedPeers).toBe(2);

    await outPeer1.push("Disconnected");
    await waitFor(() => node.syncManager.peers["peer-1"]?.closed);

    connectedPeers = await metricReader.getMetricValue("jazz.peers", {
      role: "client",
    });
    expect(connectedPeers).toBe(1);

    await outServer1.push("Disconnected");

    await waitFor(() => node.syncManager.peers["server-1"]?.closed);

    connectedServerPeers = await metricReader.getMetricValue("jazz.peers", {
      role: "server",
    });
    expect(connectedServerPeers).toBe(0);
  });
});

describe("LocalNode.load", () => {
  test("should throw error when trying to load with undefined ID", async () => {
    const client = await setupTestAccount();

    // @ts-expect-error Testing with undefined ID
    await expect(client.node.load(undefined)).rejects.toThrow(
      "Trying to load CoValue with invalid id undefined",
    );
  });

  test("should throw error when trying to load with invalid ID format", async () => {
    const client = await setupTestAccount();

    // @ts-expect-error Testing with invalid ID format
    await expect(client.node.load("invalid_id")).rejects.toThrow(
      "Trying to load CoValue with invalid id invalid_id",
    );
  });
});

describe("SyncManager.handleSyncMessage", () => {
  test("should ignore messages with undefined ID", async () => {
    const client = await setupTestAccount();

    const { peerState } = client.connectToSyncServer();

    // Create an invalid message with undefined ID
    const invalidMessage = {
      action: "load",
      id: undefined,
      header: false,
      sessions: {},
    } as unknown as LoadMessage;

    await client.node.syncManager.handleSyncMessage(invalidMessage, peerState);

    // Verify that no state changes occurred
    expect(peerState.getKnownState(invalidMessage.id)).toBe(undefined);
    expect(peerState.getOptimisticKnownState(invalidMessage.id)).toBe(
      undefined,
    );
  });

  test("should ignore messages with invalid ID format", async () => {
    const client = await setupTestAccount();

    const { peerState } = client.connectToSyncServer();

    // Create an invalid message with wrong ID format
    const invalidMessage = {
      action: "load",
      id: "invalid_id",
      header: false,
      sessions: {},
    } as unknown as LoadMessage;

    client.node.syncManager.handleSyncMessage(invalidMessage, peerState);

    // Verify that no state changes occurred
    expect(peerState.getKnownState(invalidMessage.id)).toBe(undefined);
    expect(peerState.getOptimisticKnownState(invalidMessage.id)).toBe(
      undefined,
    );
  });

  test("should ignore messages for errored coValues", async () => {
    const client = await setupTestAccount();

    const { peer, peerState } = client.connectToSyncServer();

    // Add a coValue to the errored set
    const erroredId = "co_z123" as const;
    client.node.getCoValue(erroredId).markErrored(peer.id, {
      message: "Test error",
    } as any);

    const message = {
      action: "load" as const,
      id: erroredId,
      header: false,
      sessions: {},
    } satisfies LoadMessage;

    await client.node.syncManager.handleSyncMessage(message, peerState);

    // Verify that no state changes occurred
    expect(peerState.getKnownState(message.id)).toBe(undefined);
    expect(peerState.getOptimisticKnownState(message.id)).toBe(undefined);
  });

  test("should process valid messages", async () => {
    const client = await setupTestAccount();

    const { peerState } = client.connectToSyncServer();

    const group = client.node.createGroup();

    const validMessage = {
      action: "load" as const,
      id: group.id,
      header: false,
      sessions: {},
    };

    await client.node.syncManager.handleSyncMessage(validMessage, peerState);

    // Verify that the message was processed
    expect(peerState.getKnownState(group.id)).toBeDefined();
  });
});

describe("SyncManager.trackDirtyCoValues", () => {
  test("should track the dirty coValues", async () => {
    const node = createTestNode();

    const tracking = node.syncManager.trackDirtyCoValues();

    const group = node.createGroup();
    const map = group.createMap();
    map.set("key1", "value1", "trusting");

    const trackedValues = tracking.done();
    expect(trackedValues.size).toBe(2);
    expect(trackedValues.has(map.id)).toBe(true);
    expect(trackedValues.has(group.id)).toBe(true);
  });

  test("should track the dirty coValues only when active", async () => {
    const node = createTestNode();

    const group = node.createGroup();

    const tracking1 = node.syncManager.trackDirtyCoValues();

    const map1 = group.createMap();
    map1.set("key1", "value1", "trusting");

    const tracking2 = node.syncManager.trackDirtyCoValues();

    const map2 = group.createMap();
    map2.set("key2", "value2", "trusting");

    const tracked1 = tracking1.done();

    const map3 = group.createMap();
    map3.set("key3", "value3", "trusting");

    const tracked2 = tracking2.done();

    expect(Array.from(tracked1)).toEqual([map1.id, map2.id]);
    expect(Array.from(tracked2)).toEqual([map2.id, map3.id]);
  });
});
