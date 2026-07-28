import { beforeEach, describe, expect, test, vi } from "vitest";
import { WasmCrypto } from "../crypto/WasmCrypto.js";
import {
  createTwoConnectedNodes,
  importContentIntoNode,
  loadCoValueOrFail,
  setupTestNode,
  waitFor,
} from "./testUtils.js";

beforeEach(() => {
  setupTestNode({ isSyncServer: true });
});

describe("init transaction meta", () => {
  test("a transaction with init meta is parsed correctly", () => {
    const client = setupTestNode();
    const group = client.node.createGroup();
    const map = group.createMap();

    map.core.makeTransaction(
      [{ op: "set", key: "hello", value: "world" }],
      "trusting",
      { fww: "init" },
    );

    const transactions = map.core.getValidSortedTransactions();
    expect(transactions).toHaveLength(1);
    expect(transactions[0]?.meta).toEqual({ fww: "init" });
  });

  test("first-init-wins: only the first init transaction is valid", () => {
    const client = setupTestNode();
    const group = client.node.createGroup();
    const map = group.createMap();

    // Make two init transactions with different timestamps
    // The first one (earlier madeAt) should win
    const earlierTime = Date.now();
    map.core.makeTransaction(
      [{ op: "set", key: "version", value: "first" }],
      "trusting",
      { fww: "init" },
      earlierTime,
    );

    const laterTime = earlierTime + 100;
    map.core.makeTransaction(
      [{ op: "set", key: "version", value: "second" }],
      "trusting",
      { fww: "init" },
      laterTime,
    );

    const validTransactions = map.core.getValidSortedTransactions();

    // Only the first init transaction should be valid
    expect(validTransactions).toHaveLength(1);
    expect(validTransactions[0]?.meta).toEqual({ fww: "init" });

    // The first transaction (earlier madeAt) should be the valid one
    expect(validTransactions[0]?.madeAt).toBe(earlierTime);
  });

  test("first-init-wins: transactions without init meta are not affected", () => {
    const client = setupTestNode();
    const group = client.node.createGroup();
    const map = group.createMap();

    // Make an init transaction
    map.core.makeTransaction(
      [{ op: "set", key: "version", value: "init" }],
      "trusting",
      { fww: "init" },
    );

    // Make a regular transaction (no init meta)
    map.core.makeTransaction(
      [{ op: "set", key: "hello", value: "world" }],
      "trusting",
    );

    const validTransactions = map.core.getValidSortedTransactions();

    // Both transactions should be valid
    expect(validTransactions).toHaveLength(2);
  });

  test("late-arriving winner triggers content rebuild", async () => {
    const client = setupTestNode({ connected: true });
    const clientSession2 = client.spawnNewSession();
    const group = client.node.createGroup();
    const map = group.createMap();
    const mapOnClientSession2 = await loadCoValueOrFail(
      clientSession2.node,
      map.id,
    );

    // Make an init transaction with a later timestamp
    const laterTime = Date.now() + 1000;
    map.core.makeTransaction(
      [{ op: "set", key: "version", value: "later" }],
      "trusting",
      { fww: "init" },
      laterTime,
    );

    expect(map.get("version")).toBe("later");

    // `map` is a plain (non-group) coMap, so its content is fed by the native
    // materializer (R3 stage-2b): a synced fww flip is applied via a rich-delta
    // `consumeNativeDelta` reset rather than a full `rebuildFromCore()`, so a
    // `rebuildFromCore` spy would never fire even though the content correctly
    // updates. Assert the rebuild via its OBSERVABLE effect instead: `version`
    // bumps on a genuine content-changing reset (see `RawCoMap.consumeNativeDelta`).
    const versionBefore = map.version;

    // Now make an init transaction with an earlier timestamp (this should win)
    const earlierTime = laterTime - 500;
    mapOnClientSession2.core.makeTransaction(
      [{ op: "set", key: "version", value: "earlier" }],
      "trusting",
      { fww: "init" },
      earlierTime,
    );

    await waitFor(() => {
      expect(map.core.knownState()).toEqual(
        mapOnClientSession2.core.knownState(),
      );
    });

    // The content should have been rebuilt
    expect(map.version).toBeGreaterThan(versionBefore);

    expect(map.get("version")).toBe("earlier");
  });

  test("two init transactions coming together do not trigger content rebuild", async () => {
    const alice = setupTestNode({ connected: true });
    const aliceSession2 = alice.spawnNewSession();
    const bob = setupTestNode({ connected: false });
    const group = alice.node.createGroup();
    group.addMember("everyone", "writer");
    const map = group.createMap();

    importContentIntoNode(group.core, bob.node);
    importContentIntoNode(map.core, bob.node);

    const mapOnBob = bob.node.getCoValue(map.id);
    const rebuildSpy = vi.spyOn(mapOnBob, "scheduleContentRebuild");

    const mapOnAliceSession2 = await loadCoValueOrFail(
      aliceSession2.node,
      map.id,
    );

    // Make an init transaction with a later timestamp
    const laterTime = Date.now() + 1000;
    map.core.makeTransaction(
      [{ op: "set", key: "version", value: "later" }],
      "trusting",
      { fww: "init" },
      laterTime,
    );

    expect(map.get("version")).toBe("later");

    // Now make an init transaction with an earlier timestamp (this should win)
    const earlierTime = laterTime - 500;
    mapOnAliceSession2.core.makeTransaction(
      [{ op: "set", key: "version", value: "earlier" }],
      "trusting",
      { fww: "init" },
      earlierTime,
    );

    await waitFor(() => {
      expect(map.core.knownState()).toEqual(
        mapOnAliceSession2.core.knownState(),
      );
    });

    importContentIntoNode(map.core, bob.node);

    // The content should have been rebuilt
    expect(rebuildSpy).not.toHaveBeenCalled();

    expect(mapOnBob.getCurrentContent().toJSON()).toEqual({
      version: "earlier",
    });
    expect(map.get("version")).toBe("earlier");
  });

  test("content reflects the winning init transaction after rebuild", async () => {
    const client = setupTestNode({ connected: true });
    const clientSession2 = client.spawnNewSession();
    const group = client.node.createGroup();
    const map = group.createMap();
    const mapOnClientSession2 = await loadCoValueOrFail(
      clientSession2.node,
      map.id,
    );

    // Make an init transaction with a later timestamp
    const laterTime = Date.now() + 1000;
    map.core.makeTransaction(
      [{ op: "set", key: "version", value: "later" }],
      "trusting",
      { fww: "init" },
      laterTime,
    );

    // Verify initial content
    expect(map.get("version")).toBe("later");

    // Now make an init transaction with an earlier timestamp (this should win)
    const earlierTime = laterTime - 500;
    mapOnClientSession2.core.makeTransaction(
      [{ op: "set", key: "version", value: "earlier" }],
      "trusting",
      { fww: "init" },
      earlierTime,
    );

    await waitFor(() => {
      expect(map.core.knownState()).toEqual(
        mapOnClientSession2.core.knownState(),
      );
    });

    // The content should reflect the earlier (winning) init transaction
    expect(map.get("version")).toBe("earlier");
  });

  test("losing init transaction is marked as invalid (different sessions)", async () => {
    const client = setupTestNode({ connected: true });
    const clientSession2 = client.spawnNewSession();
    const group = client.node.createGroup();
    const map = group.createMap();

    const mapOnClientSession2 = await loadCoValueOrFail(
      clientSession2.node,
      map.id,
    );

    const earlierTime = Date.now();
    map.core.makeTransaction(
      [{ op: "set", key: "version", value: "first" }],
      "trusting",
      { fww: "init" },
      earlierTime,
    );

    const laterTime = earlierTime + 100;
    mapOnClientSession2.core.makeTransaction(
      [{ op: "set", key: "version", value: "second" }],
      "trusting",
      { fww: "init" },
      laterTime,
    );

    await waitFor(() => {
      expect(map.core.knownState()).toEqual(
        mapOnClientSession2.core.knownState(),
      );
    });

    // `map` is a plain (non-group) coMap, so its content is fed by the native
    // materializer (R3 stage-2b), which never populates the TS-only
    // `verifiedTransactions` introspection array. Trigger the lazy TS-side load
    // explicitly to inspect the raw per-transaction validity/reason.
    map.core.getValidTransactions();

    // Check the raw verified transactions
    const allTransactions = map.core.verifiedTransactions;
    expect(allTransactions).toHaveLength(2);

    // The first transaction should be valid
    const firstTx = allTransactions.find((tx) => tx.madeAt === earlierTime);
    expect(firstTx?.isValid).toBe(true);

    // The second transaction should be invalid
    const secondTx = allTransactions.find((tx) => tx.madeAt === laterTime);
    expect(secondTx?.isValid).toBe(false);
    expect(secondTx?.validationErrorMessage).toBe(
      `Transaction is not the first writer for fww key "init"`,
    );
  });

  test("losing init transaction is marked as invalid (same session)", () => {
    const client = setupTestNode();
    const group = client.node.createGroup();
    const map = group.createMap();

    const earlierTime = Date.now();
    map.core.makeTransaction(
      [{ op: "set", key: "version", value: "first" }],
      "trusting",
      { fww: "init" },
      earlierTime,
    );

    const laterTime = earlierTime + 100;
    map.core.makeTransaction(
      [{ op: "set", key: "version", value: "second" }],
      "trusting",
      { fww: "init" },
      laterTime,
    );

    // `map` is a plain (non-group) coMap, so its content is fed by the native
    // materializer (R3 stage-2b), which never populates the TS-only
    // `verifiedTransactions` introspection array. Trigger the lazy TS-side load
    // explicitly to inspect the raw per-transaction validity/reason.
    map.core.getValidTransactions();

    // Check the raw verified transactions
    const allTransactions = map.core.verifiedTransactions;
    expect(allTransactions).toHaveLength(2);

    // The first transaction should be valid
    const firstTx = allTransactions.find((tx) => tx.madeAt === earlierTime);
    expect(firstTx?.isValid).toBe(true);

    // The second transaction should be invalid
    const secondTx = allTransactions.find((tx) => tx.madeAt === laterTime);
    expect(secondTx?.isValid).toBe(false);
    expect(secondTx?.validationErrorMessage).toBe(
      `Transaction is not the first writer for fww key "init"`,
    );
  });

  test("validity change on processed transaction dispatches rebuild", async () => {
    const client = setupTestNode({ connected: true });
    const clientSession2 = client.spawnNewSession();
    const group = client.node.createGroup();
    const map = group.createMap();

    const mapOnClientSession2 = await loadCoValueOrFail(
      clientSession2.node,
      map.id,
    );

    // Make an init transaction and process it
    const laterTime = Date.now() + 1000;
    map.core.makeTransaction(
      [{ op: "set", key: "version", value: "later" }],
      "trusting",
      { fww: "init" },
      laterTime,
    );

    // `map` is a plain (non-group) coMap, so its content is fed by the native
    // materializer (R3 stage-2b), which never populates the TS-only
    // `verifiedTransactions` introspection array. Trigger the lazy TS-side load
    // explicitly to inspect the raw per-transaction stage/validity.
    map.core.getValidTransactions();

    // Check the transaction is marked as processed
    const laterTx = map.core.verifiedTransactions.find(
      (tx) => tx.madeAt === laterTime,
    );
    expect(laterTx?.stage).toBe("processed");
    expect(laterTx?.isValid).toBe(true);

    // Add a new init transaction with an earlier timestamp
    const earlierTime = laterTime - 500;
    mapOnClientSession2.core.makeTransaction(
      [{ op: "set", key: "version", value: "earlier" }],
      "trusting",
      { fww: "init" },
      earlierTime,
    );

    await waitFor(() => {
      expect(map.core.knownState()).toEqual(
        mapOnClientSession2.core.knownState(),
      );
    });

    // The native receive path materializes the coMap view directly and does
    // not keep the TS-only `verifiedTransactions` mirror live-updated for a
    // native-gated map — re-pull it explicitly to see the fww flip reflected.
    map.core.getValidTransactions();
    const laterTxAfter = map.core.verifiedTransactions.find(
      (tx) => tx.madeAt === laterTime,
    );

    // The later transaction should now be invalid
    expect(laterTxAfter?.isValid).toBe(false);
  });

  test("synced init transactions resolve correctly across nodes", async () => {
    const { node1, node2 } = await createTwoConnectedNodes("server", "server");

    const group = node1.node.createGroup();
    group.addMember("everyone", "writer");

    const map = group.createMap();

    // Make an init transaction on node1
    map.core.makeTransaction(
      [{ op: "set", key: "version", value: "node1" }],
      "trusting",
      { fww: "init" },
    );

    await map.core.waitForSync();

    // Load the map on node2
    const mapOnNode2 = await loadCoValueOrFail(node2.node, map.id);

    await waitFor(() => {
      expect(mapOnNode2.get("version")).toBe("node1");
    });

    // Both nodes should have the same valid transaction
    const node1ValidTxs = map.core.getValidSortedTransactions();
    const node2ValidTxs = mapOnNode2.core.getValidSortedTransactions();

    expect(node1ValidTxs).toHaveLength(1);
    expect(node2ValidTxs).toHaveLength(1);
    expect(node1ValidTxs[0]?.madeAt).toBe(node2ValidTxs[0]?.madeAt);
  });

  test("concurrent init transactions from different nodes resolve deterministically", async () => {
    const { node1, node2 } = await createTwoConnectedNodes("server", "server");

    const group = node1.node.createGroup();
    group.addMember("everyone", "writer");

    const map = group.createMap();

    await map.core.waitForSync();

    // Load the map on node2
    const mapOnNode2 = await loadCoValueOrFail(node2.node, map.id);

    // Make init transactions on both nodes with different timestamps
    const node1Time = Date.now();
    const node2Time = node1Time + 1000; // node2 is later

    map.core.makeTransaction(
      [{ op: "set", key: "version", value: "node1" }],
      "trusting",
      { fww: "init" },
      node1Time,
    );

    mapOnNode2.core.makeTransaction(
      [{ op: "set", key: "version", value: "node2" }],
      "trusting",
      { fww: "init" },
      node2Time,
    );

    // Wait for sync
    await map.core.waitForSync();
    await mapOnNode2.core.waitForSync();

    // Wait for microtasks
    await new Promise<void>((resolve) => queueMicrotask(resolve));

    // Both nodes should converge to the same winner (node1 with earlier timestamp)
    await waitFor(() => {
      expect(map.get("version")).toBe("node1");
      expect(mapOnNode2.get("version")).toBe("node1");
    });
  });

  test("subscription is notified when init transaction changes the content", async () => {
    const client = setupTestNode();
    const group = client.node.createGroup();
    const map = group.createMap();

    // Make an init transaction with a later timestamp
    const laterTime = Date.now() + 1000;
    map.core.makeTransaction(
      [{ op: "set", key: "version", value: "later" }],
      "trusting",
      { fww: "init" },
      laterTime,
    );

    // Subscribe to changes
    const subscriptionSpy = vi.fn();
    const unsubscribe = map.subscribe(subscriptionSpy);

    subscriptionSpy.mockClear();

    // Add a new init transaction with an earlier timestamp
    const earlierTime = laterTime - 500;
    map.core.makeTransaction(
      [{ op: "set", key: "version", value: "earlier" }],
      "trusting",
      { fww: "init" },
      earlierTime,
    );

    // Wait for notifications
    await waitFor(() => {
      expect(subscriptionSpy).toHaveBeenCalled();
    });

    unsubscribe();
  });

  test("getValidTransactions returns discarded init transactions when includeInvalidMetaTransactions is true", async () => {
    const { node1, node2 } = await createTwoConnectedNodes("server", "server");

    const group = node1.node.createGroup();
    group.addMember("everyone", "writer");

    const map = group.createMap();

    const earlierTime = Date.now();
    const laterTime = earlierTime + 1000;

    map.core.makeTransaction(
      [{ op: "set", key: "version", value: "later" }],
      "trusting",
      { fww: "init" },
      laterTime,
    );

    await map.core.waitForSync();

    const mapOnNode2 = await loadCoValueOrFail(node2.node, map.id);

    await waitFor(() => {
      expect(mapOnNode2.get("version")).toBe("later");
    });

    mapOnNode2.core.makeTransaction(
      [{ op: "set", key: "version", value: "earlier" }],
      "trusting",
      { fww: "init" },
      earlierTime,
    );

    await waitFor(() => {
      expect(map.core.knownState()).toEqual(mapOnNode2.core.knownState());
    });

    // Without flag: only valid transactions
    const validOnly = map.core.getValidSortedTransactions();
    expect(validOnly).toHaveLength(1);
    expect(validOnly[0]?.madeAt).toBe(earlierTime);

    // With flag: includes invalid init transactions
    const withInvalid = map.core.getValidSortedTransactions({
      includeInvalidMetaTransactions: true,
      ignorePrivateTransactions: false,
    });
    expect(withInvalid).toHaveLength(2);
    expect(withInvalid.filter((tx) => tx.isValid)).toHaveLength(1);
    expect(withInvalid.filter((tx) => !tx.isValid)).toHaveLength(1);
  });

  test("getValidTransactions({includeInvalidMetaTransactions: true}) does not return permission-invalid transactions", async () => {
    const { node1, node2 } = await createTwoConnectedNodes("server", "server");

    const group = node1.node.createGroup();
    const map = group.createMap();

    group.addMember(node2.node.getCurrentAgent(), "reader");

    map.set("key", "admin-value", "trusting");

    await map.core.waitForSync();

    const mapOnReader = await loadCoValueOrFail(node2.node, map.id);

    await waitFor(() => {
      expect(mapOnReader.get("key")).toBe("admin-value");
    });

    mapOnReader.set("key", "reader-value", "trusting");

    // Permission-invalid transactions are never included
    const allTx = mapOnReader.core.getValidSortedTransactions({
      includeInvalidMetaTransactions: true,
      ignorePrivateTransactions: false,
    });

    expect(allTx).toHaveLength(1);
    expect(mapOnReader.get("key")).toBe("admin-value");
  });

  test("different FWW keys are independent", () => {
    const client = setupTestNode();
    const group = client.node.createGroup();
    const map = group.createMap();

    // Make two FWW transactions with different keys
    map.core.makeTransaction(
      [{ op: "set", key: "keyA", value: "valueA" }],
      "trusting",
      { fww: "keyA" },
    );

    map.core.makeTransaction(
      [{ op: "set", key: "keyB", value: "valueB" }],
      "trusting",
      { fww: "keyB" },
    );

    const validTransactions = map.core.getValidSortedTransactions();

    // Both transactions should be valid since they have different FWW keys
    expect(validTransactions).toHaveLength(2);
    expect(validTransactions[0]?.meta).toEqual({ fww: "keyA" });
    expect(validTransactions[1]?.meta).toEqual({ fww: "keyB" });
  });

  test("FWW at non-zero txIndex is valid", () => {
    const client = setupTestNode();
    const group = client.node.createGroup();
    const map = group.createMap();

    // Make a regular transaction first (no FWW meta)
    map.core.makeTransaction(
      [{ op: "set", key: "setup", value: "regular" }],
      "trusting",
    );

    // Make an FWW transaction at txIndex > 0
    map.core.makeTransaction(
      [{ op: "set", key: "version", value: "init" }],
      "trusting",
      { fww: "init" },
    );

    const validTransactions = map.core.getValidSortedTransactions();

    // Both transactions should be valid
    expect(validTransactions).toHaveLength(2);

    // The FWW transaction should be valid even though it's not at txIndex 0
    const fwwTx = validTransactions.find((tx) => tx.meta?.fww === "init");
    expect(fwwTx).toBeDefined();
    expect(fwwTx?.isValid).toBe(true);
  });

  test("multiple FWW keys with different winners", async () => {
    const client = setupTestNode({ connected: true });
    const clientSession2 = client.spawnNewSession();
    const group = client.node.createGroup();
    const map = group.createMap();

    const mapOnClientSession2 = await loadCoValueOrFail(
      clientSession2.node,
      map.id,
    );

    const earlierTime = Date.now();
    const laterTime = earlierTime + 100;

    // Session 1: Make FWW transaction for "keyA" with earlier time
    map.core.makeTransaction(
      [{ op: "set", key: "keyA", value: "session1" }],
      "trusting",
      { fww: "keyA" },
      earlierTime,
    );

    // Session 1: Make FWW transaction for "keyB" with later time
    map.core.makeTransaction(
      [{ op: "set", key: "keyB", value: "session1" }],
      "trusting",
      { fww: "keyB" },
      laterTime,
    );

    // Session 2: Make FWW transaction for "keyA" with later time
    mapOnClientSession2.core.makeTransaction(
      [{ op: "set", key: "keyA", value: "session2" }],
      "trusting",
      { fww: "keyA" },
      laterTime,
    );

    // Session 2: Make FWW transaction for "keyB" with earlier time
    mapOnClientSession2.core.makeTransaction(
      [{ op: "set", key: "keyB", value: "session2" }],
      "trusting",
      { fww: "keyB" },
      earlierTime,
    );

    await waitFor(() => {
      expect(map.core.knownState()).toEqual(
        mapOnClientSession2.core.knownState(),
      );
    });

    // Each key should independently pick its winner
    // keyA: session1 wins (earlier time)
    // keyB: session2 wins (earlier time)
    const validTransactions = map.core.getValidSortedTransactions();
    expect(validTransactions).toHaveLength(2);

    const keyAWinner = validTransactions.find((tx) => tx.meta?.fww === "keyA");
    const keyBWinner = validTransactions.find((tx) => tx.meta?.fww === "keyB");

    expect(keyAWinner).toBeDefined();
    expect(keyBWinner).toBeDefined();

    // Verify the correct values are in the map
    expect(map.get("keyA")).toBe("session1");
    expect(map.get("keyB")).toBe("session2");
  });

  test("multiple FWW keys resolve independently across synced nodes", async () => {
    const { node1, node2 } = await createTwoConnectedNodes("server", "server");

    const group = node1.node.createGroup();
    group.addMember("everyone", "writer");

    const map = group.createMap();

    await map.core.waitForSync();

    // Load the map on node2
    const mapOnNode2 = await loadCoValueOrFail(node2.node, map.id);

    const earlierTime = Date.now();
    const laterTime = earlierTime + 1000;

    // On node1: create FWW transaction for "keyA" with earlier time, "keyB" with later time
    map.core.makeTransaction(
      [{ op: "set", key: "keyA", value: "node1" }],
      "trusting",
      { fww: "keyA" },
      earlierTime,
    );

    map.core.makeTransaction(
      [{ op: "set", key: "keyB", value: "node1" }],
      "trusting",
      { fww: "keyB" },
      laterTime,
    );

    // On node2: create FWW transaction for "keyA" with later time, "keyB" with earlier time
    mapOnNode2.core.makeTransaction(
      [{ op: "set", key: "keyA", value: "node2" }],
      "trusting",
      { fww: "keyA" },
      laterTime,
    );

    mapOnNode2.core.makeTransaction(
      [{ op: "set", key: "keyB", value: "node2" }],
      "trusting",
      { fww: "keyB" },
      earlierTime,
    );

    // Wait for sync
    await map.core.waitForSync();
    await mapOnNode2.core.waitForSync();

    // Wait for microtasks
    await new Promise<void>((resolve) => queueMicrotask(resolve));

    // Both nodes should converge to the same state
    // keyA: node1 wins (earlier timestamp)
    // keyB: node2 wins (earlier timestamp)
    await waitFor(() => {
      expect(map.get("keyA")).toBe("node1");
      expect(map.get("keyB")).toBe("node2");
      expect(mapOnNode2.get("keyA")).toBe("node1");
      expect(mapOnNode2.get("keyB")).toBe("node2");
    });

    // Verify both nodes have exactly 2 valid transactions (one per key)
    const node1ValidTxs = map.core.getValidSortedTransactions();
    const node2ValidTxs = mapOnNode2.core.getValidSortedTransactions();

    expect(node1ValidTxs).toHaveLength(2);
    expect(node2ValidTxs).toHaveLength(2);
  });

  test("late-arriving winner for one key does not affect other keys", async () => {
    const client = setupTestNode({ connected: true });
    const clientSession2 = client.spawnNewSession();
    const group = client.node.createGroup();
    const map = group.createMap();

    const mapOnClientSession2 = await loadCoValueOrFail(
      clientSession2.node,
      map.id,
    );

    const earlierTime = Date.now();
    const laterTime = earlierTime + 1000;

    // Session 1: Create FWW transaction for "keyA" with later time
    map.core.makeTransaction(
      [{ op: "set", key: "keyA", value: "session1" }],
      "trusting",
      { fww: "keyA" },
      laterTime,
    );

    // Session 1: Create FWW transaction for "keyB" (any time)
    map.core.makeTransaction(
      [{ op: "set", key: "keyB", value: "session1" }],
      "trusting",
      { fww: "keyB" },
      earlierTime,
    );

    // Verify initial state
    expect(map.get("keyA")).toBe("session1");
    expect(map.get("keyB")).toBe("session1");

    // Session 2: Create FWW transaction for "keyA" with earlier time (this should win)
    mapOnClientSession2.core.makeTransaction(
      [{ op: "set", key: "keyA", value: "session2" }],
      "trusting",
      { fww: "keyA" },
      earlierTime,
    );

    await waitFor(() => {
      expect(map.core.knownState()).toEqual(
        mapOnClientSession2.core.knownState(),
      );
    });

    // After sync:
    // keyA: session2's transaction wins (earlier timestamp), session1's is invalidated
    // keyB: session1's transaction remains valid (unaffected)
    expect(map.get("keyA")).toBe("session2");
    expect(map.get("keyB")).toBe("session1");

    // Check that both keys have exactly one valid transaction each
    const allTransactions = map.core.getValidSortedTransactions({
      includeInvalidMetaTransactions: true,
      ignorePrivateTransactions: false,
    });

    // Should have 3 total transactions: 2 for keyA (one invalid), 1 for keyB (valid)
    expect(allTransactions).toHaveLength(3);

    // keyA transactions
    const keyATransactions = allTransactions.filter(
      (tx) => tx.meta?.fww === "keyA",
    );
    expect(keyATransactions).toHaveLength(2);
    expect(keyATransactions.filter((tx) => tx.isValid)).toHaveLength(1);
    expect(keyATransactions.filter((tx) => !tx.isValid)).toHaveLength(1);

    // The winning keyA transaction should be from session2 (earlier time)
    const validKeyA = keyATransactions.find((tx) => tx.isValid);
    expect(validKeyA?.madeAt).toBe(earlierTime);

    // keyB transaction should be valid (unaffected by keyA's late-arriving winner)
    const keyBTransactions = allTransactions.filter(
      (tx) => tx.meta?.fww === "keyB",
    );
    expect(keyBTransactions).toHaveLength(1);
    expect(keyBTransactions[0]?.isValid).toBe(true);
  });
});
