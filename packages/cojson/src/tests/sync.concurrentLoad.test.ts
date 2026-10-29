import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  CO_VALUE_LOADING_CONFIG,
  GARBAGE_COLLECTOR_CONFIG,
  setGarbageCollectorMaxAge,
  setMaxInFlightLoadsPerPeer,
} from "../config.js";
import {
  blockMessageTypeOnOutgoingPeer,
  fillCoMapWithLargeData,
  loadCoValueOrFail,
  setupTestNode,
  SyncMessagesLog,
  TEST_NODE_CONFIG,
  waitFor,
} from "./testUtils.js";

let jazzCloud: ReturnType<typeof setupTestNode>;

// Store original config values
let originalMaxInFlightLoads: number;
let originalTimeout: number;
let originalGarbageCollectorMaxAge: number;

beforeEach(async () => {
  // We want to simulate a real world communication that happens asynchronously
  TEST_NODE_CONFIG.withAsyncPeers = true;

  originalMaxInFlightLoads =
    CO_VALUE_LOADING_CONFIG.MAX_IN_FLIGHT_LOADS_PER_PEER;
  originalTimeout = CO_VALUE_LOADING_CONFIG.TIMEOUT;
  originalGarbageCollectorMaxAge = GARBAGE_COLLECTOR_CONFIG.MAX_AGE;

  SyncMessagesLog.clear();
  jazzCloud = setupTestNode({ isSyncServer: true });
});

afterEach(() => {
  // Restore original config
  setMaxInFlightLoadsPerPeer(originalMaxInFlightLoads);
  CO_VALUE_LOADING_CONFIG.TIMEOUT = originalTimeout;
  setGarbageCollectorMaxAge(originalGarbageCollectorMaxAge);
  vi.useRealTimers();
});

describe("concurrent load", () => {
  test("should throttle load requests when at capacity", async () => {
    setMaxInFlightLoadsPerPeer(2);

    const client = setupTestNode({
      connected: false,
    });

    const { peerOnServer } = client.connectToSyncServer();

    // Create multiple CoValues on the server
    const group = jazzCloud.node.createGroup();
    const map1 = group.createMap();
    const map2 = group.createMap();
    const map3 = group.createMap();

    map1.set("key", "value1");
    map2.set("key", "value2");
    map3.set("key", "value3");

    // Block content responses to see the throttling effect
    const blocker = blockMessageTypeOnOutgoingPeer(peerOnServer, "content", {});

    // Start loading all three
    const promise1 = client.node.loadCoValueCore(map1.id);
    const promise2 = client.node.loadCoValueCore(map2.id);
    const promise3 = client.node.loadCoValueCore(map3.id);

    // Wait for messages to be sent
    await new Promise((resolve) => setTimeout(resolve, 10));

    // Get the LOAD messages sent
    const loadMessages = SyncMessagesLog.messages.filter(
      (m) => m.msg.action === "load",
    );

    // Only 2 LOAD messages should have been sent (throttled)
    expect(loadMessages.length).toBe(2);

    // Unblock and let it complete
    blocker.unblock();
    blocker.sendBlockedMessages();

    await Promise.all([promise1, promise2, promise3]);

    // After completion, all 3 should have been loaded
    const allLoadMessages = SyncMessagesLog.messages.filter(
      (m) => m.msg.action === "load",
    );
    expect(allLoadMessages.length).toBe(3);

    // Verify all were loaded successfully despite throttling
    expect(
      SyncMessagesLog.getMessages({
        Group: group.core,
        Map1: map1.core,
        Map2: map2.core,
        Map3: map3.core,
      }),
    ).toMatchInlineSnapshot(`
      [
        "client -> server | LOAD Map1 sessions: empty",
        "client -> server | LOAD Map2 sessions: empty",
        "server -> client | CONTENT Group header: true new: After: 0 New: 4",
        "server -> client | CONTENT Map1 header: true new: After: 0 New: 1",
        "server -> client | CONTENT Map2 header: true new: After: 0 New: 1",
        "client -> server | KNOWN Group sessions: header/4",
        "client -> server | KNOWN Map1 sessions: header/1",
        "client -> server | LOAD Map3 sessions: empty",
        "client -> server | KNOWN Map2 sessions: header/1",
        "server -> client | CONTENT Map3 header: true new: After: 0 New: 1",
        "client -> server | KNOWN Map3 sessions: header/1",
      ]
    `);
  });

  test("should process pending loads when capacity becomes available", async () => {
    setMaxInFlightLoadsPerPeer(1);

    const client = setupTestNode({
      connected: true,
    });

    // Create multiple CoValues on the server
    const group = jazzCloud.node.createGroup();
    const map1 = group.createMap();
    const map2 = group.createMap();

    map1.set("key", "value1", "trusting");
    map2.set("key", "value2", "trusting");

    // Load both sequentially due to throttling
    const [result1, result2] = await Promise.all([
      loadCoValueOrFail(client.node, map1.id),
      loadCoValueOrFail(client.node, map2.id),
    ]);

    expect(result1.get("key")).toBe("value1");
    expect(result2.get("key")).toBe("value2");

    // Verify both were loaded successfully despite throttling
    expect(
      SyncMessagesLog.getMessages({
        Group: group.core,
        Map1: map1.core,
        Map2: map2.core,
      }),
    ).toMatchInlineSnapshot(`
      [
        "client -> server | LOAD Map1 sessions: empty",
        "server -> client | CONTENT Group header: true new: After: 0 New: 4",
        "server -> client | CONTENT Map1 header: true new: After: 0 New: 1",
        "client -> server | KNOWN Group sessions: header/4",
        "client -> server | KNOWN Map1 sessions: header/1",
        "client -> server | LOAD Map2 sessions: empty",
        "server -> client | CONTENT Map2 header: true new: After: 0 New: 1",
        "client -> server | KNOWN Map2 sessions: header/1",
      ]
    `);
  });

  test("should prioritize unavailable CoValues over available ones", async () => {
    setMaxInFlightLoadsPerPeer(1);

    const client = setupTestNode({
      connected: true,
    });

    // Create CoValues on the server
    const group = jazzCloud.node.createGroup();
    const map1 = group.createMap();
    const map2 = group.createMap();
    const map3 = group.createMap();

    map1.set("key", "value1", "trusting");
    map2.set("key", "value2", "trusting");
    map3.set("key", "value3", "trusting");

    // First, load map1 to make it "available" locally
    await loadCoValueOrFail(client.node, map1.id);

    SyncMessagesLog.clear();

    // Update map1 on server (so client has stale version)
    map1.set("key", "updated1", "trusting");

    // Now load map2 (unavailable) and reload map1 (available but outdated)
    // map2 should be prioritized
    const [result1, result2] = await Promise.all([
      loadCoValueOrFail(client.node, map1.id), // Available, lower priority
      loadCoValueOrFail(client.node, map2.id), // Unavailable, higher priority
    ]);

    // Both should succeed
    expect(result2.get("key")).toBe("value2");

    // map2 (unavailable) should have been loaded first
    const loadMessages = SyncMessagesLog.messages.filter(
      (m) => m.msg.action === "load",
    );
    expect(loadMessages.length).toBeGreaterThanOrEqual(1);
    // The first load should be for map2 (unavailable, high priority)
    expect(loadMessages[0]?.msg).toMatchObject({
      action: "load",
      id: map2.id,
    });
  });

  test("should handle high load with many concurrent requests", async () => {
    setMaxInFlightLoadsPerPeer(5);

    const client = setupTestNode({
      connected: true,
    });

    // Create many CoValues on the server
    const group = jazzCloud.node.createGroup();
    const maps = Array.from({ length: 20 }, (_, i) => {
      const map = group.createMap();
      map.set("index", i, "trusting");
      return map;
    });

    // Load all of them concurrently
    const results = await Promise.all(
      maps.map((map) => loadCoValueOrFail(client.node, map.id)),
    );

    // All should have been loaded successfully
    results.forEach((result, i) => {
      expect(result.get("index")).toBe(i);
    });
  });

  test("should timeout load requests that take too long", async () => {
    vi.useFakeTimers();
    setMaxInFlightLoadsPerPeer(1);
    CO_VALUE_LOADING_CONFIG.TIMEOUT = 1000;

    const client = setupTestNode({
      connected: false,
    });

    const { peerOnServer } = client.connectToSyncServer();

    // Create a CoValue on the server
    const group = jazzCloud.node.createGroup();
    const map = group.createMap();
    map.set("key", "value");

    // Block content to simulate a slow/unresponsive server
    const blocker = blockMessageTypeOnOutgoingPeer(peerOnServer, "content", {
      id: map.id,
    });

    const loadPromise = client.node.loadCoValueCore(map.id);

    // Advance past the timeout
    await vi.advanceTimersByTimeAsync(CO_VALUE_LOADING_CONFIG.TIMEOUT + 100);

    // The queue slot should be freed
    // The second retry attempt should happen after RETRY_DELAY
    await vi.advanceTimersByTimeAsync(
      CO_VALUE_LOADING_CONFIG.RETRY_DELAY + 100,
    );

    // Unblock to let retries succeed
    blocker.sendBlockedMessages();
    blocker.unblock();

    // Wait for the retry to complete
    await vi.advanceTimersByTimeAsync(100);

    const result = await loadPromise;

    // The retry should have succeeded (since we unblocked)
    expect(result.isAvailable()).toBe(true);
  });

  test("should free queue slots on disconnect", async () => {
    setMaxInFlightLoadsPerPeer(2);

    const client = setupTestNode({
      connected: false,
    });

    const { peerState, peerOnServer } = client.connectToSyncServer();

    // Create CoValues on the server
    const group = jazzCloud.node.createGroup();
    const map1 = group.createMap();
    const map2 = group.createMap();
    const map3 = group.createMap();

    // Block content to keep requests in-flight
    const blocker = blockMessageTypeOnOutgoingPeer(peerOnServer, "content", {});

    // Start loading (will be in-flight)
    client.node.loadCoValueCore(map1.id);
    client.node.loadCoValueCore(map2.id);
    client.node.loadCoValueCore(map3.id);

    await new Promise((resolve) => setTimeout(resolve, 10));

    // Disconnect
    peerState.gracefulShutdown();

    // Queue should be cleared
    // Reconnect and verify new requests can be sent
    client.connectToSyncServer();

    const result = await loadCoValueOrFail(client.node, map1.id);
    expect(result.get("key")).toBeUndefined(); // map1 was created without a key

    blocker.unblock();
  });

  test("should handle reconnection with pending loads", async () => {
    setMaxInFlightLoadsPerPeer(1);

    const client = setupTestNode({
      connected: false,
    });

    const { peerState, peerOnServer } = client.connectToSyncServer({
      persistent: true,
    });

    // Create a CoValue on the server
    const group = jazzCloud.node.createGroup();
    const map = group.createMap();
    map.set("key", "value");

    // Block content to keep request in-flight
    blockMessageTypeOnOutgoingPeer(peerOnServer, "content", {
      id: map.id,
    });

    // Start loading
    const loadPromise = client.node.loadCoValueCore(map.id);

    await new Promise((resolve) => setTimeout(resolve, 10));

    // Disconnect
    peerState.gracefulShutdown();

    // Reconnect
    client.connectToSyncServer({
      persistent: true,
    });

    // The load should complete after reconnection
    const result = await loadPromise;
    expect(result.isAvailable()).toBe(true);
  });

  test("should maintain FIFO order for queued requests", async () => {
    setMaxInFlightLoadsPerPeer(1);

    const client = setupTestNode({
      connected: false,
    });

    const { peerOnServer } = client.connectToSyncServer();

    // Create CoValues on the server
    const group = jazzCloud.node.createGroup();
    const maps = Array.from({ length: 5 }, () => group.createMap());

    // Block content to build up the queue
    const blocker = blockMessageTypeOnOutgoingPeer(peerOnServer, "content", {});

    // Start loading all maps (first one goes in-flight, rest queued)
    const loadPromises = maps.map((map) => client.node.loadCoValueCore(map.id));

    await new Promise((resolve) => setTimeout(resolve, 10));

    // Get the LOAD messages before unblocking
    const loadMessagesBefore = SyncMessagesLog.messages.filter(
      (m) => m.msg.action === "load",
    );

    // Only 1 should be sent (at capacity)
    expect(loadMessagesBefore.length).toBe(1);
    expect(loadMessagesBefore[0]?.msg).toMatchObject({
      action: "load",
      id: maps[0]?.id,
    });

    // Unblock to process the queue
    blocker.sendBlockedMessages();
    blocker.unblock();

    await Promise.all(loadPromises);

    // Verify all LOAD messages were sent
    const allLoadMessages = SyncMessagesLog.messages.filter(
      (m) => m.msg.action === "load",
    );

    // All 5 should eventually be sent
    expect(allLoadMessages.length).toBe(5);

    // They should be in order (maps[0], maps[1], maps[2], maps[3], maps[4])
    for (let i = 0; i < allLoadMessages.length; i++) {
      expect(allLoadMessages[i]?.msg).toMatchObject({
        action: "load",
        id: maps[i]?.id,
      });
    }
  });

  test("should allow dependency loads to overflow the concurrency limit", async () => {
    setMaxInFlightLoadsPerPeer(1);

    const server = setupTestNode();

    const client = setupTestNode({ connected: false });
    client.connectToSyncServer({
      ourName: "client",
      syncServerName: "server",
      syncServer: server.node,
    });

    // Create a CoValue on the server - the Map depends on the Group
    const group = server.node.createGroup();
    group.addMember("everyone", "writer");
    const map = group.createMap();
    map.set("key", "value");

    // Delete the Group from server so it won't be pushed with the Map content
    // skipVerify prevents the server from checking dependencies before sending
    server.node.syncManager.disableTransactionVerification();
    // Capture the Group content before deleting it: internalDeleteCoValue now
    // evicts the NodeCore registry entry, so group.core can no longer be read
    // back afterwards. Re-inject this captured content below (step 6) to
    // simulate the Group becoming available again.
    const groupContent = group.core.newContentSince(undefined);
    if (!groupContent) {
      throw new Error("Expected group content before delete");
    }
    server.node.internalDeleteCoValue(group.id);

    // Load the map from the client
    // The flow is:
    // 1. Client sends LOAD Map to server (takes the slot, limit=1)
    // 2. Server responds with Map content (no deps pushed because skipVerify + Group deleted)
    // 3. Client sees missing dependency (Group), sends LOAD Group to server
    //    This would be blocked by limit=1 without allowOverflow since Map load slot is taken
    // 4. With allowOverflow, Group load bypasses the queue
    // 5. Server responds with KNOWN Group (doesn't have it - was deleted)
    // 6. Group content is moved back to server (simulating it becoming available)
    // 7. Server responds with Group content
    // 8. Client can now process Map content
    const promise = loadCoValueOrFail(client.node, map.id);

    // Wait for the Map content to be sent
    await waitFor(() => SyncMessagesLog.messages.length >= 2);

    // 6. Group content is moved back to server (simulating it becoming available)
    const groupChunk = groupContent[0];
    if (!groupChunk) {
      throw new Error("Expected at least one group content chunk");
    }
    server.node.syncManager.handleNewContent(groupChunk, "import");

    const result = await promise;
    expect(result.get("key")).toBe("value");

    // Verify both were loaded successfully despite throttling
    expect(
      SyncMessagesLog.getMessages({
        Group: group.core,
        Map: map.core,
      }),
    ).toMatchInlineSnapshot(`
      [
        "client -> server | LOAD Map sessions: empty",
        "server -> client | CONTENT Map header: true new: After: 0 New: 1",
        "client -> server | LOAD Group sessions: empty",
        "server -> client | KNOWN Group sessions: empty",
        "server -> client | CONTENT Group header: true new: After: 0 New: 6",
        "client -> server | KNOWN Group sessions: header/6",
        "client -> server | KNOWN Map sessions: header/1",
      ]
    `);
  });

  test("should forward client LOAD to core even when edge is at concurrency limit", async () => {
    setMaxInFlightLoadsPerPeer(1);
    CO_VALUE_LOADING_CONFIG.TIMEOUT = 60_000;

    const core = jazzCloud;
    const edge = setupTestNode({ connected: false });

    const { peerOnServer: edgePeerOnCore, peerState: corePeerOnEdge } =
      edge.connectToSyncServer({
        ourName: "edge",
        syncServerName: "core",
        syncServer: core.node,
        persistent: true,
      });

    const client = setupTestNode({ connected: false });
    client.connectToSyncServer({
      ourName: "client",
      syncServerName: "edge",
      syncServer: edge.node,
    });

    // Create two CoValues on core so edge has to forward LOADs to core.
    const group = core.node.createGroup();
    const map1 = group.createMap();
    const map2 = group.createMap();

    map1.set("key", "value1", "trusting");
    map2.set("key", "value2", "trusting");

    // Keep the first edge->core load in-flight to saturate the concurrency limit.
    const blocker = blockMessageTypeOnOutgoingPeer(
      edgePeerOnCore,
      "content",
      {},
    );

    const edgeLoadPromise = edge.node.loadCoValueCore(map1.id);

    await waitFor(() => {
      const simplified = SyncMessagesLog.getMessages({
        Group: group.core,
        Map1: map1.core,
        Map2: map2.core,
      });
      return simplified.some(
        (m) => m === "edge -> core | LOAD Map1 sessions: empty",
      );
    });

    // Ensure the edge->core peer is already at its concurrency limit (1 in-flight load).
    // @ts-expect-error loadQueue is private
    expect(corePeerOnEdge.loadQueue.inFlightCount).toBe(1);

    SyncMessagesLog.clear();

    // Now the client asks the edge for map2. Edge must forward the LOAD to core
    // even though it already has an in-flight load to core and the limit is 1.
    const clientLoadPromise = client.node.loadCoValueCore(map2.id);

    await waitFor(() => {
      const simplified = SyncMessagesLog.getMessages({
        Group: group.core,
        Map1: map1.core,
        Map2: map2.core,
      });
      expect(simplified).toContain("edge -> core | LOAD Map2 sessions: empty");
      return true;
    });

    blocker.unblock();
    blocker.sendBlockedMessages();

    const [map1OnEdge, map2OnClient] = await Promise.all([
      edgeLoadPromise,
      clientLoadPromise,
    ]);

    expect(map1OnEdge.isAvailable()).toBe(true);
    expect(map2OnClient.isAvailable()).toBe(true);
  });

  test("should keep load slot occupied while streaming large CoValues", async () => {
    setMaxInFlightLoadsPerPeer(1);

    const client = setupTestNode({
      connected: false,
    });

    const { peerState, peerOnServer } = client.connectToSyncServer();

    // Create a large CoValue that requires multiple chunks to stream
    const group = jazzCloud.node.createGroup();
    const largeMap = group.createMap();
    fillCoMapWithLargeData(largeMap);

    // Create a small CoValue that will be queued
    const smallMap = group.createMap();
    smallMap.set("key", "value", "trusting");

    // Block all the streaming chunks, except the first content message
    const blocker = blockMessageTypeOnOutgoingPeer(peerOnServer, "content", {
      id: largeMap.id,
      matcher: (msg) => msg.action === "content" && !msg.expectContentUntil,
    });

    // Start loading both maps concurrently
    const largeMapOnClient = await client.node.loadCoValueCore(largeMap.id);
    const smallMapPromise = client.node.loadCoValueCore(smallMap.id);

    expect(client.node.getCoValue(largeMap.id).isStreaming()).toBe(true);

    await new Promise((resolve) => setTimeout(resolve, 10));

    // The SmallMap load should still be waiting in the queue
    expect(
      SyncMessagesLog.getMessages({
        Group: group.core,
        LargeMap: largeMapOnClient,
        SmallMap: smallMap.core,
      }),
    ).toMatchInlineSnapshot(`
      [
        "client -> server | LOAD LargeMap sessions: empty",
        "server -> client | CONTENT Group header: true new: After: 0 New: 4",
        "server -> client | CONTENT LargeMap header: true new: After: 0 New: 73 expectContentUntil: header/200",
        "client -> server | KNOWN Group sessions: header/4",
        "client -> server | KNOWN LargeMap sessions: header/73",
      ]
    `);

    // Now unblock and send all remaining chunks to complete streaming
    blocker.unblock();
    blocker.sendBlockedMessages();

    await client.node.getCoValue(largeMap.id).waitForFullStreaming();

    const loadedSmallMap = await smallMapPromise;
    expect(loadedSmallMap.isAvailable()).toBe(true);
  });

  test("should prioritize user-initiated loads over peer reconciliation loads", async () => {
    setMaxInFlightLoadsPerPeer(1);

    // Create CoValues on the server before the client connects
    const group = jazzCloud.node.createGroup();

    const [a, b, c] = [
      group.createMap({ test: "a" }),
      group.createMap({ test: "b" }),
      group.createMap({ test: "c" }),
    ];

    const client = setupTestNode({
      connected: false,
    });
    const { peerState } = client.connectToSyncServer();

    // Load a CoValue to make it available locally
    await loadCoValueOrFail(client.node, a.id);
    await loadCoValueOrFail(client.node, b.id);

    // Close the peer connection
    peerState.gracefulShutdown();

    SyncMessagesLog.clear();

    // Reconnect to the server to trigger the reconciliation load
    client.connectToSyncServer();

    // The reconciliation load should be in the low-priority queue
    // Now make a user-initiated load for a different CoValue
    await loadCoValueOrFail(client.node, c.id);

    // Wait for the reconciliation loads to be sent
    await waitFor(() => SyncMessagesLog.messages.length >= 8);

    // Expect Group, C, A, B
    expect(
      SyncMessagesLog.getMessages({
        Group: group.core,
        A: a.core,
        B: b.core,
        C: c.core,
      }),
    ).toMatchInlineSnapshot(`
      [
        "client -> server | LOAD Group sessions: header/4",
        "server -> client | KNOWN Group sessions: header/4",
        "client -> server | LOAD C sessions: empty",
        "server -> client | CONTENT C header: true new: After: 0 New: 1",
        "client -> server | KNOWN C sessions: header/1",
        "client -> server | LOAD A sessions: header/1",
        "server -> client | KNOWN A sessions: header/1",
        "client -> server | LOAD B sessions: header/1",
        "server -> client | KNOWN B sessions: header/1",
      ]
    `);
  });

  test("should upgrade low-priority reconciliation load to high-priority when user requests it", async () => {
    setMaxInFlightLoadsPerPeer(1);

    // Create CoValues on the server before the client connects
    const group = jazzCloud.node.createGroup();

    const [a, b, c] = [
      group.createMap({ test: "a" }),
      group.createMap({ test: "b" }),
      group.createMap({ test: "c" }),
    ];

    const client = setupTestNode({
      connected: false,
    });

    // Load both CoValues to make them marked as unavailable
    await client.node.loadCoValueCore(a.id);
    await client.node.loadCoValueCore(b.id);
    await client.node.loadCoValueCore(c.id);

    // Reconnect to the server to trigger the reconciliation load
    client.connectToSyncServer();

    // The reconciliation load should be in the low-priority queue
    // Now try to bump-up the priority of the load for c
    client.node.loadCoValueCore(c.id);

    // Wait for the reconciliation loads to be sent
    await waitFor(() => SyncMessagesLog.messages.length >= 6);

    // Expect A, C, B
    expect(
      SyncMessagesLog.getMessages({
        Group: group.core,
        A: a.core,
        B: b.core,
        C: c.core,
      }),
    ).toMatchInlineSnapshot(`
      [
        "client -> server | LOAD A sessions: empty",
        "server -> client | CONTENT Group header: true new: After: 0 New: 4",
        "server -> client | CONTENT A header: true new: After: 0 New: 1",
        "client -> server | KNOWN Group sessions: header/4",
        "client -> server | KNOWN A sessions: header/1",
        "client -> server | LOAD C sessions: empty",
        "server -> client | CONTENT C header: true new: After: 0 New: 1",
        "client -> server | KNOWN C sessions: header/1",
        "client -> server | LOAD B sessions: empty",
        "server -> client | CONTENT B header: true new: After: 0 New: 1",
        "client -> server | KNOWN B sessions: header/1",
      ]
    `);
  });

  test("should consider garbageCollected load requests processed when server replies with KNOWN", async () => {
    setMaxInFlightLoadsPerPeer(1);
    setGarbageCollectorMaxAge(-1);

    const client = setupTestNode({
      connected: false,
    });
    client.addStorage({ ourName: "client" });
    client.node.enableGarbageCollector();

    const group = client.node.createGroup();
    const map1 = group.createMap();
    const map2 = group.createMap();

    map1.set("key", "value1", "trusting");
    map2.set("key", "value2", "trusting");

    const { peerState } = client.connectToSyncServer();
    await client.node.syncManager.waitForAllCoValuesSync();

    // Disconnect and GC so the node keeps only garbageCollected shells with cached knownState.
    peerState.gracefulShutdown();
    client.node.garbageCollector?.collect();
    client.node.garbageCollector?.collect();

    const gcGroup = client.node.getCoValue(group.id);
    const gcMap1 = client.node.getCoValue(map1.id);
    const gcMap2 = client.node.getCoValue(map2.id);

    expect(gcGroup.loadingState).toBe("garbageCollected");
    expect(gcMap1.loadingState).toBe("garbageCollected");
    expect(gcMap2.loadingState).toBe("garbageCollected");

    SyncMessagesLog.clear();

    client.connectToSyncServer();

    await waitFor(() => {
      const messages = SyncMessagesLog.getMessages({
        Group: gcGroup,
        Map1: gcMap1,
        Map2: gcMap2,
      });

      expect(messages).toMatchInlineSnapshot(`
        [
          "client -> server | LOAD Group sessions: header/4",
          "server -> client | KNOWN Group sessions: header/4",
          "client -> server | LOAD Map1 sessions: header/1",
          "server -> client | KNOWN Map1 sessions: header/1",
          "client -> server | LOAD Map2 sessions: header/1",
          "server -> client | KNOWN Map2 sessions: header/1",
        ]
      `);
      return true;
    });

    // Create a new group to test that the load queue is now empty
    const groupToTestTheLoadQueue = await loadCoValueOrFail(
      client.node,
      jazzCloud.node.createGroup().id,
    );
    expect(groupToTestTheLoadQueue.core.isAvailable()).toBe(true);
  });

  test("should load garbageCollected CoValues when receiving KNOWN from a peer", async () => {
    setGarbageCollectorMaxAge(-1);

    const client = setupTestNode({
      connected: false,
    });
    client.addStorage({ ourName: "client" });
    client.node.enableGarbageCollector();

    const group = client.node.createGroup();
    const map = group.createMap();
    map.set("key", "value", "trusting");

    client.node.garbageCollector?.collect();
    client.node.garbageCollector?.collect();

    const gcMap = client.node.getCoValue(map.id);
    expect(gcMap.loadingState).toBe("garbageCollected");

    const { peerState } = client.connectToSyncServer({
      skipReconciliation: true,
    });

    const loadSpy = vi.spyOn(client.node, "loadCoValueCore");

    client.node.syncManager.handleKnownState(
      {
        action: "known",
        id: map.id,
        header: false,
        sessions: {},
      },
      peerState,
    );

    expect(loadSpy).toHaveBeenCalledWith(map.id);

    loadSpy.mockRestore();
  });

  test("should consider onlyKnownState load requests processed when server replies with KNOWN", async () => {
    setMaxInFlightLoadsPerPeer(1);

    const client = setupTestNode({
      connected: false,
    });
    const { storage } = client.addStorage({ ourName: "client" });

    const group = client.node.createGroup();
    const map1 = group.createMap();
    const map2 = group.createMap();

    map1.set("key", "value1", "trusting");
    map2.set("key", "value2", "trusting");

    const { peerState } = client.connectToSyncServer();
    await client.node.syncManager.waitForAllCoValuesSync();
    peerState.gracefulShutdown();

    await client.restart();
    client.addStorage({ storage });

    const onlyKnownGroup = client.node.getCoValue(group.id);
    const onlyKnownMap1 = client.node.getCoValue(map1.id);
    const onlyKnownMap2 = client.node.getCoValue(map2.id);

    await Promise.all([
      new Promise<void>((resolve) =>
        onlyKnownGroup.getKnownStateFromStorage(() => resolve()),
      ),
      new Promise<void>((resolve) =>
        onlyKnownMap1.getKnownStateFromStorage(() => resolve()),
      ),
      new Promise<void>((resolve) =>
        onlyKnownMap2.getKnownStateFromStorage(() => resolve()),
      ),
    ]);

    expect(onlyKnownGroup.loadingState).toBe("onlyKnownState");
    expect(onlyKnownMap1.loadingState).toBe("onlyKnownState");
    expect(onlyKnownMap2.loadingState).toBe("onlyKnownState");

    SyncMessagesLog.clear();

    client.connectToSyncServer();

    await waitFor(() => {
      const messages = SyncMessagesLog.getMessages({
        Group: onlyKnownGroup,
        Map1: onlyKnownMap1,
        Map2: onlyKnownMap2,
      });

      expect(messages).toMatchInlineSnapshot(`
        [
          "client -> server | LOAD Group sessions: header/4",
          "server -> client | KNOWN Group sessions: header/4",
          "client -> server | LOAD Map1 sessions: header/1",
          "server -> client | KNOWN Map1 sessions: header/1",
          "client -> server | LOAD Map2 sessions: header/1",
          "server -> client | KNOWN Map2 sessions: header/1",
        ]
      `);
      return true;
    });

    // Create a new group to test that the load queue is now empty
    const groupToTestTheLoadQueue = await loadCoValueOrFail(
      client.node,
      jazzCloud.node.createGroup().id,
    );
    expect(groupToTestTheLoadQueue.core.isAvailable()).toBe(true);
  });

  test("should keep onlyKnownState while peer load is pending and KNOWN replies arrive", async () => {
    const client = setupTestNode({
      connected: false,
    });
    const { storage } = client.addStorage({ ourName: "client" });

    const group = client.node.createGroup();
    const map = group.createMap();
    map.set("key", "value", "trusting");

    const initialConnection = client.connectToSyncServer();
    await client.node.syncManager.waitForAllCoValuesSync();
    initialConnection.peerState.gracefulShutdown();

    await client.restart();
    client.addStorage({ storage });

    const onlyKnownMap = client.node.getCoValue(map.id);
    await new Promise<void>((resolve) =>
      onlyKnownMap.getKnownStateFromStorage(() => resolve()),
    );
    expect(onlyKnownMap.loadingState).toBe("onlyKnownState");

    // Force explicit loads to use peers (not local full-content storage).
    vi.spyOn(storage, "load").mockImplementation(
      async (_id: unknown, _cb: unknown, done: (result: boolean) => void) =>
        done(false),
    );

    const { peerState } = client.connectToSyncServer({
      skipReconciliation: true,
    });

    SyncMessagesLog.clear();

    onlyKnownMap.load([peerState]);

    await waitFor(() => {
      const messages = SyncMessagesLog.getMessages({
        Group: client.node.getCoValue(group.id),
        Map: onlyKnownMap,
      });

      expect(messages).toContain(
        "client -> server | LOAD Map sessions: header/1",
      );
      expect(messages).toContain(
        "server -> client | KNOWN Map sessions: header/1",
      );
      return true;
    });

    expect(onlyKnownMap.getLoadingStateForPeer(peerState.id)).toBe("pending");
    expect(onlyKnownMap.loadingState).toBe("onlyKnownState");
  });

  /**
   * This test covers the case where the client is streaming a value from storage and since the value is already on the server
   * the server sends only a KNOWN message.
   *
   * Without a specialized logic the value results inStreaming and the "load" would be considered in-flight indefinitely.
   */
  test("should process queued loads when KNOWN arrives while first CoValue is streaming from storage", async () => {
    setMaxInFlightLoadsPerPeer(1);

    const client = setupTestNode({
      connected: true,
    });
    const { storage } = await client.addAsyncStorage({ ourName: "client" });

    const group = jazzCloud.node.createGroup();
    const streamingMap = group.createMap();
    fillCoMapWithLargeData(streamingMap);

    const queuedMap = group.createMap();
    queuedMap.set("key", "value", "trusting");

    const mapOnClient = await loadCoValueOrFail(client.node, streamingMap.id);
    await mapOnClient.core.waitForFullStreaming();

    await client.restart();
    client.addStorage({ storage });
    client.connectToSyncServer();

    SyncMessagesLog.clear();

    const originalLoad = storage.load.bind(storage);
    let firstChunk = true;
    const pausedOps: (() => void)[] = [];

    vi.spyOn(storage, "load").mockImplementation(async (id, callback, done) => {
      if (id !== streamingMap.id) {
        return originalLoad(id, callback, done);
      }

      return originalLoad(
        id,
        (chunk) => {
          if (firstChunk) {
            firstChunk = false;
            callback(chunk);
          } else {
            pausedOps.push(() => callback(chunk));
          }
        },
        (found) => {
          pausedOps.push(() => done(found));
        },
      );
    });

    const streamingMapOnClientPromise = client.node.loadCoValueCore(
      streamingMap.id,
    );

    await waitFor(() => {
      expect(firstChunk).toBe(false);
    });

    const queuedMapOnClient = await client.node.loadCoValueCore(queuedMap.id);

    expect(queuedMapOnClient.isAvailable()).toBe(true);

    for (const op of pausedOps) {
      op();
    }

    const streamingMapOnClient = await streamingMapOnClientPromise;
    expect(streamingMapOnClient.isStreaming()).toBe(false);
  });

  test("should process queued loads when CoValue instance changes while in-flight", async () => {
    setMaxInFlightLoadsPerPeer(1);

    const client = setupTestNode({
      connected: false,
    });
    const { storage } = client.addStorage({ ourName: "client" });

    const { peerOnServer } = client.connectToSyncServer();

    const group = jazzCloud.node.createGroup();
    const map1 = group.createMap();
    const map2 = group.createMap();

    map1.set("key", "value1", "trusting");
    map2.set("key", "value2", "trusting");

    // Prime map1 locally so GC leaves a shell with knownState.
    await loadCoValueOrFail(client.node, map1.id);

    // Force load attempts to go through peers instead of satisfying from storage.
    vi.spyOn(storage, "load").mockImplementation(
      async (_id: unknown, _cb: unknown, done: (result: boolean) => void) =>
        done(false),
    );

    const unmounted = client.node.internalUnmountCoValue(map1.id);
    expect(unmounted).toBe(true);
    expect(client.node.getCoValue(map1.id).loadingState).toBe(
      "garbageCollected",
    );

    const blockedKnown = blockMessageTypeOnOutgoingPeer(peerOnServer, "known", {
      id: map1.id,
    });

    SyncMessagesLog.clear();

    const map1LoadPromise = client.node.loadCoValueCore(map1.id);
    const map2LoadPromise = client.node.loadCoValueCore(map2.id);

    await waitFor(() => {
      expect(
        SyncMessagesLog.messages.some(
          (m) => m.msg.action === "load" && m.msg.id === map1.id,
        ),
      ).toBe(true);
      return true;
    });

    // Queue is saturated by map1 while KNOWN(Map1) is blocked.
    expect(
      SyncMessagesLog.messages.some(
        (m) => m.msg.action === "load" && m.msg.id === map2.id,
      ),
    ).toBe(false);

    // Replace the in-flight CoValue instance with a new one (same id).
    const oldMap1Core = client.node.getCoValue(map1.id);
    const oldMap1KnownState = oldMap1Core.knownState();
    client.node.internalDeleteCoValue(map1.id);

    const newMap1Core = client.node.getCoValue(map1.id);
    expect(newMap1Core).not.toBe(oldMap1Core);
    newMap1Core.setGarbageCollectedState(oldMap1KnownState);
    expect(newMap1Core.loadingState).toBe("garbageCollected");

    // Deliver KNOWN(Map1). With ID-based tracking, this should free the slot and send LOAD(Map2).
    blockedKnown.unblock();
    blockedKnown.sendBlockedMessages();

    await waitFor(() => {
      expect(
        SyncMessagesLog.messages.some(
          (m) => m.msg.action === "known" && m.msg.id === map1.id,
        ),
      ).toBe(true);
      expect(
        SyncMessagesLog.messages.some(
          (m) => m.msg.action === "load" && m.msg.id === map2.id,
        ),
      ).toBe(true);
      return true;
    });

    // The critical behavior is that map2 starts loading after KNOWN(map1).
    const map2OnClient = await loadCoValueOrFail(client.node, map2.id);
    expect(map2OnClient.get("key")).toBe("value2");

    // Avoid unhandled promise rejection in case these earlier promises resolve later.
    void map1LoadPromise;
    void map2LoadPromise;
  });
});
