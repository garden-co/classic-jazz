import {
  assert,
  afterEach,
  beforeEach,
  describe,
  expect,
  test,
  vi,
} from "vitest";
import { CoValueCore, idforHeader } from "../coValueCore/coValueCore.js";
import { WasmCrypto } from "../crypto/WasmCrypto.js";
import { Stringified } from "../jsonStringify.js";
import { LocalNode } from "../localNode.js";
import {
  agentAndSessionIDFromSecret,
  createTestMetricReader,
  createTestNode,
  createTwoConnectedNodes,
  createUnloadedCoValue,
  loadCoValueOrFail,
  nodeWithRandomAgentAndSessionID,
  randomAgentAndSessionID,
  setupTestAccount,
  setupTestNode,
  tearDownTestMetricReader,
  waitFor,
} from "./testUtils.js";
import { CO_VALUE_PRIORITY } from "../priority.js";
import { JsonValue } from "../jsonValue.js";

const Crypto = await WasmCrypto.create();

let metricReader: ReturnType<typeof createTestMetricReader>;
const agentSecret =
  "sealerSecret_zE3Nr7YFr1KkVbJSx4JDCzYn4ApYdm8kJ5ghNBxREHQya/signerSecret_z9fEu4eNG1eXHMak3YSzY7uLdoG8HESSJ8YW4xWdNNDSP";

beforeEach(() => {
  metricReader = createTestMetricReader();
  setupTestNode({ isSyncServer: true });
});

afterEach(() => {
  tearDownTestMetricReader();
});

test("transactions with wrong signature are rejected", () => {
  const node = nodeWithRandomAgentAndSessionID();

  const coValue = node.createCoValue({
    type: "costream",
    ruleset: { type: "unsafeAllowAll" },
    meta: null,
    ...Crypto.createdNowUnique(),
  });

  const { transaction, signature } =
    coValue.verified.makeNewTrustingTransaction(
      node.currentSessionID,
      node.getCurrentAgent(),
      [{ hello: "world" }],
      undefined,
      Date.now(),
    );

  transaction.madeAt = Date.now() + 1000;

  // Delete the transaction from the coValue
  node.internalDeleteCoValue(coValue.id);
  node.syncManager.handleNewContent(
    {
      action: "content",
      id: coValue.id,
      header: coValue.verified.header,
      priority: CO_VALUE_PRIORITY.LOW,
      new: {},
    },
    "import",
  );

  const newEntry = node.getCoValue(coValue.id);

  const error = newEntry.tryAddTransactions(
    node.currentSessionID,
    [transaction],
    signature,
  );

  expect(Boolean(error)).toBe(true);
  expect(newEntry.getValidSortedTransactions().length).toBe(0);
});

describe("transactions that exceed the byte size limit are rejected", () => {
  test("makeTransaction should throw error when transaction exceeds byte size limit", () => {
    const [agent, sessionID] = randomAgentAndSessionID();
    const node = new LocalNode(agent.agentSecret, sessionID, Crypto);

    const coValue = node.createCoValue({
      type: "costream",
      ruleset: { type: "unsafeAllowAll" },
      meta: null,
      ...Crypto.createdNowUnique(),
    });

    const largeBinaryData = "x".repeat(1024 * 1024 + 100);

    expect(() => {
      coValue.makeTransaction(
        [
          {
            data: largeBinaryData,
          },
        ],
        "trusting",
      );
    }).toThrow(
      /Transaction too large to be synced: 1048689 bytes > 1048576 bytes limit/,
    );
  });

  test("makeTransaction should work for transactions under byte size limit", () => {
    const [agent, sessionID] = randomAgentAndSessionID();
    const node = new LocalNode(agent.agentSecret, sessionID, Crypto);

    const coValue = node.createCoValue({
      type: "costream",
      ruleset: { type: "unsafeAllowAll" },
      meta: null,
      ...Crypto.createdNowUnique(),
    });

    const smallData = "Hello, world!";

    const success = coValue.makeTransaction(
      [
        {
          data: smallData,
        },
      ],
      "trusting",
    );

    expect(success).toBe(true);
  });
});

test("subscribe to a map emits an update when a new transaction is added", async () => {
  const client = await setupTestAccount();

  const group = client.node.createGroup();

  const map = group.createMap();

  const subscriptionSpy = vi.fn();
  const unsubscribe = map.core.subscribe(subscriptionSpy, false);

  map.set("hello", "world");

  await waitFor(() => {
    expect(subscriptionSpy).toHaveBeenCalled();
  });

  expect(subscriptionSpy).toHaveBeenCalledTimes(1);
  unsubscribe();
});

test("new transactions in a group correctly update owned values, including subscriptions", async () => {
  const alice = await setupTestAccount({
    connected: true,
  });

  const bob = await setupTestAccount({
    connected: true,
  });

  const bobAccount = await loadCoValueOrFail(alice.node, bob.accountID);
  const group = alice.node.createGroup();

  group.addMember(bobAccount, "writer");

  const map = group.createMap();

  await new Promise((resolve) => setTimeout(resolve, 10));

  const mapOnBob = await loadCoValueOrFail(bob.node, map.id);
  mapOnBob.set("hello", "world");

  const transaction = mapOnBob.core.getValidSortedTransactions().at(-1);

  assert(transaction);

  expect(transaction.isValid).toBe(true);
  expect(group.roleOf(bobAccount.id)).toBe("writer");

  group.core.makeTransaction(
    [
      {
        op: "set",
        key: bobAccount.id,
        value: "revoked",
      },
    ],
    "trusting",
    undefined,
    transaction.madeAt - 1, // Make the revocation to be before the map update
  );

  await group.core.waitForSync();

  expect(transaction.isValid).toBe(false);
  expect(mapOnBob.core.getValidSortedTransactions().length).toBe(0);
  expect(map.core.getValidSortedTransactions().length).toBe(0);
});

test("new transactions in a parent group correctly update owned values, including subscriptions", async () => {
  const alice = await setupTestAccount({
    connected: true,
  });

  const bob = await setupTestAccount({
    connected: true,
  });

  const bobAccount = await loadCoValueOrFail(alice.node, bob.accountID);
  const parentGroup = alice.node.createGroup();

  parentGroup.addMember(bobAccount, "writer");

  const group = alice.node.createGroup();
  group.extend(parentGroup);

  const map = group.createMap();

  await new Promise((resolve) => setTimeout(resolve, 10));

  const mapOnBob = await loadCoValueOrFail(bob.node, map.id);
  mapOnBob.set("hello", "world");

  const transaction = mapOnBob.core.getValidSortedTransactions().at(-1);

  assert(transaction);

  expect(transaction.isValid).toBe(true);
  expect(group.roleOf(bobAccount.id)).toBe("writer");

  parentGroup.core.makeTransaction(
    [
      {
        op: "set",
        key: bobAccount.id,
        value: "revoked",
      },
    ],
    "trusting",
    undefined,
    transaction.madeAt - 1, // Make the revocation to be before the map update
  );

  await parentGroup.core.waitForSync();

  expect(transaction.isValid).toBe(false);
  expect(mapOnBob.core.getValidSortedTransactions().length).toBe(0);
  expect(map.core.getValidSortedTransactions().length).toBe(0);
});

test("resetParsedTransactions triggers rebuildFromCore only when the validation state changes", async () => {
  const alice = await setupTestAccount({
    connected: true,
  });
  const bob = await setupTestAccount({
    connected: true,
  });

  const group = alice.node.createGroup();

  const map = group.createMap();

  map.set("hello", "world");

  const rebuildOnAliceSpy = vi.spyOn(map, "rebuildFromCore");

  const mapOnBob = await loadCoValueOrFail(bob.node, map.id);

  const rebuildOnBobSpy = vi.spyOn(mapOnBob, "rebuildFromCore");

  group.addMember("everyone", "reader");

  await group.core.waitForSync();

  expect(rebuildOnAliceSpy).toHaveBeenCalledTimes(0);
  expect(rebuildOnBobSpy).toHaveBeenCalledTimes(1);
});

test("group change trigger a subscription emit, even if the content doesn't change", async () => {
  const alice = await setupTestAccount({
    connected: true,
  });
  const bob = await setupTestAccount({
    connected: true,
  });

  const group = alice.node.createGroup();

  const map = group.createMap();

  map.set("hello", "world");

  const mapOnBob = await loadCoValueOrFail(bob.node, map.id);

  const aliceSubscriptionSpy = vi.fn();
  const aliceUnsubscribe = map.subscribe(aliceSubscriptionSpy);
  const bobSubscriptionSpy = vi.fn();
  const bobUnsubscribe = mapOnBob.subscribe(bobSubscriptionSpy);
  aliceSubscriptionSpy.mockClear();
  bobSubscriptionSpy.mockClear();

  group.addMember("everyone", "reader");

  await waitFor(() => {
    expect(aliceSubscriptionSpy).toHaveBeenCalledTimes(1);
    expect(bobSubscriptionSpy).toHaveBeenCalledTimes(1);
  });

  aliceUnsubscribe();
  bobUnsubscribe();
});

test("changing parent and child group trigger only one invalidation on the local map", async () => {
  const alice = await setupTestAccount();

  const parentGroup = alice.node.createGroup();
  const group = alice.node.createGroup();
  group.extend(parentGroup);

  const map = group.createMap();

  map.set("hello", "world");

  const aliceSubscriptionSpy = vi.fn();
  const aliceUnsubscribe = map.subscribe(aliceSubscriptionSpy);
  aliceSubscriptionSpy.mockClear();

  parentGroup.addMember("everyone", "reader");
  group.addMember("everyone", "reader");

  await waitFor(() => {
    expect(aliceSubscriptionSpy).toHaveBeenCalledTimes(1);
  });

  aliceUnsubscribe();
});

test("correctly records transactions", async () => {
  const node = nodeWithRandomAgentAndSessionID();

  const changes1 = JSON.stringify([{ hello: "world" }]) as Stringified<
    JsonValue[]
  >;
  node.syncManager.recordTransactionsSize(
    [
      {
        privacy: "trusting",
        changes: changes1,
        madeAt: Date.now(),
      },
    ],
    "server",
  );

  let value = await metricReader.getMetricValue("jazz.transactions.size", {
    source: "server",
  });
  assert(typeof value !== "number" && !!value?.count);
  expect(value.count).toBe(1);
  expect(value.sum).toBe(changes1.length);

  const changes2 = JSON.stringify([{ foo: "bar" }]) as Stringified<JsonValue[]>;
  node.syncManager.recordTransactionsSize(
    [
      {
        privacy: "trusting",
        changes: changes2,
        madeAt: Date.now(),
      },
    ],
    "server",
  );

  value = await metricReader.getMetricValue("jazz.transactions.size", {
    source: "server",
  });
  assert(typeof value !== "number" && !!value?.count);
  expect(value.count).toBe(2);
  expect(value.sum).toBe(changes1.length + changes2.length);
});

test("(smoke test) records transactions from local node", async () => {
  const node = nodeWithRandomAgentAndSessionID();

  node.createGroup();

  let value = await metricReader.getMetricValue("jazz.transactions.size", {
    source: "local",
  });

  assert(typeof value !== "number" && !!value?.count);
  // Creating a group now creates 4 transactions: admin member, key revelation, readKey, and groupSealer
  expect(value.count).toBe(4);
});

test("creating a coValue with a group should't trigger automatically a content creation (performance)", () => {
  const node = createTestNode();

  const group = node.createGroup();

  const getCurrentContentSpy = vi.spyOn(
    CoValueCore.prototype,
    "getCurrentContent",
  );
  const groupSpy = vi.spyOn(group.core, "getCurrentContent");

  getCurrentContentSpy.mockClear();

  node.createCoValue({
    type: "comap",
    ruleset: { type: "ownedByGroup", group: group.id },
    meta: null,
    ...Crypto.createdNowUnique(),
  });

  // It's called once for the group and never for the coValue
  expect(getCurrentContentSpy).toHaveBeenCalledTimes(0);
  expect(groupSpy).toHaveBeenCalledTimes(0);

  getCurrentContentSpy.mockRestore();
});

test("loading a coValue core without having the owner group available doesn't crash", () => {
  const node = nodeWithRandomAgentAndSessionID();

  const otherNode = createTestNode();

  const group = otherNode.createGroup();

  const coValue = node.createCoValue({
    type: "costream",
    ruleset: { type: "ownedByGroup", group: group.id },
    meta: null,
    ...Crypto.createdNowUnique(),
  });

  expect(coValue.id).toBeDefined();
});

test("listeners are notified even if the previous listener threw an error", async () => {
  const { node1, node2 } = await createTwoConnectedNodes("server", "server");

  const group = node1.node.createGroup();
  group.addMember("everyone", "writer");

  const coMap = group.createMap();

  const spy1 = vi.fn();
  const spy2 = vi.fn();

  coMap.subscribe(spy1);
  coMap.subscribe(spy2);

  spy1.mockImplementation(() => {
    throw new Error("test");
  });

  const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});

  coMap.set("hello", "world");

  expect(spy1).toHaveBeenCalledTimes(2);
  expect(spy2).toHaveBeenCalledTimes(2);
  expect(errorLog).toHaveBeenCalledTimes(1);

  await coMap.core.waitForSync();

  const mapOnNode2 = await loadCoValueOrFail(node2.node, coMap.id);

  expect(mapOnNode2.get("hello")).toBe("world");

  errorLog.mockRestore();
});

test("creates a transaction with trusting meta information", async () => {
  const client = setupTestNode();

  const group = client.node.createGroup();
  const map = group.createMap();
  map.core.makeTransaction([], "trusting", {
    meta: true,
  });

  // `map` is a plain (non-group) coMap, so its content is fed by the native
  // materializer (R3 stage-2b), which never populates the TS-only
  // `verifiedTransactions` introspection array (this transaction has no
  // `changes` anyway, so it produces no coMap op either way). Trigger the lazy
  // TS-side load explicitly to inspect the raw parsed meta.
  map.core.getValidTransactions();

  expect(map.core.verifiedTransactions[0]?.tx.meta).toBe(`{"meta":true}`);
  expect(map.core.verifiedTransactions[0]?.meta).toEqual({ meta: true });
});

test("creates a transaction with private meta information", async () => {
  const client = setupTestNode({ connected: true });

  const group = client.node.createGroup();
  const map = group.createMap();
  map.core.makeTransaction([], "private", {
    meta: true,
  });

  const localTransactionMeta = map.core.verified.decryptTransactionMeta(
    client.node.currentSessionID,
    0,
    map.core.getCurrentReadKey().secret!,
  );

  expect(localTransactionMeta).toEqual({ meta: true });

  const newSession = client.spawnNewSession();

  const mapOnNewSession = await loadCoValueOrFail(newSession.node, map.id);

  const syncedTransactionMeta =
    mapOnNewSession.core.verified.decryptTransactionMeta(
      client.node.currentSessionID,
      0,
      mapOnNewSession.core.getCurrentReadKey().secret!,
    );

  expect(syncedTransactionMeta).toEqual({ meta: true });
});

test("getValidTransactions should skip private transactions with invalid JSON", () => {
  const [agent, sessionID] = agentAndSessionIDFromSecret(agentSecret);
  const node = new LocalNode(agent.agentSecret, sessionID, Crypto);

  const fixtures = {
    id: "co_zWwrEiushQLvbkWd6Z3L8WxTU1r",
    signature:
      "signature_z3ktW7wxMnW7VYExCGZv4Ug2UJSW3ag6zLDiP8GpZThzif6veJt7JipYpUgshhuGbgHtLcWywWSWysV7hChxFypDt",
    decrypted:
      '[{"after":"start","op":"app","value":"co_zMphsnYN6GU8nn2HDY5suvyGufY"}]',
    key: {
      secret: "keySecret_z3dU66SsyQkkGKpNCJW6NX74MnfVGHUyY7r85b4M8X88L",
      id: "key_z5XUAHyoqUV9zXWvMK",
    },
    transaction: {
      privacy: "private",
      madeAt: 0,
      encryptedChanges:
        "encrypted_UNAxqdUSGRZ2rzuLU99AFPKCe2C0HwsTzMWQreXZqLr6RpWrSMa-5lwgwIev7xPHTgZFq5UyUgMFrO9zlHJHJGgjJcDzFihY=" as any,
      keyUsed: "key_z5XUAHyoqUV9zXWvMK",
    },
    session:
      "sealer_z5yhsCCe2XwLTZC4254mUoMASshm3Diq49JrefPpjTktp/signer_z7gVGDpNz9qUtsRxAkHMuu4DYdtVVCG4XELTKPYdoYLPr_session_z9mDP8FoonSA",
  } as const;

  const group = node.createGroup();
  const map = group.createMap();

  map.set("hello", "world");

  // This should fail silently, because the encryptedChanges will be outputted as gibberish
  map.core.tryAddTransactions(
    fixtures.session,
    [fixtures.transaction],
    fixtures.signature,
  );

  // Get valid transactions - should only include the valid one
  const validTransactions = map.core.getValidTransactions();

  expect(validTransactions).toHaveLength(1);
});

describe("markErrored and isErroredInPeer", () => {
  test("markErrored should mark a peer as errored with the provided error", () => {
    const [agent, sessionID] = randomAgentAndSessionID();
    const node = new LocalNode(agent.agentSecret, sessionID, Crypto);

    const coValue = node.createCoValue({
      type: "costream",
      ruleset: { type: "unsafeAllowAll" },
      meta: null,
      ...Crypto.createdNowUnique(),
    });

    const peerId = "test-peer-1";
    const testError = {
      type: "InvalidSignature" as const,
      id: coValue.id,
      newSignature: "invalid-signature" as any,
      sessionID: sessionID,
      signerID: "test-signer" as any,
    };

    // Initially, the peer should not be errored
    expect(coValue.isErroredInPeer(peerId)).toBe(false);

    // Mark the peer as errored
    coValue.markErrored(peerId, testError);

    // Verify the peer is now marked as errored
    expect(coValue.isErroredInPeer(peerId)).toBe(true);

    // Verify the peer state contains the error
    expect(coValue.getLoadingStateForPeer(peerId)).toBe("errored");
  });

  test("markErrored should update loading state and notify listeners", () => {
    const [agent, sessionID] = randomAgentAndSessionID();
    const node = new LocalNode(agent.agentSecret, sessionID, Crypto);

    const coValue = node.createCoValue({
      type: "costream",
      ruleset: { type: "unsafeAllowAll" },
      meta: null,
      ...Crypto.createdNowUnique(),
    });

    const peerId = "test-peer-2";
    const testError = {
      type: "InvalidHash" as const,
      id: coValue.id,
      expectedNewHash: "expected-hash" as any,
      givenExpectedNewHash: "given-hash" as any,
    };

    const listener = vi.fn();
    coValue.subscribe(listener);

    // Mark the peer as errored
    coValue.markErrored(peerId, testError);

    // Verify the listener was called
    expect(listener).toHaveBeenCalled();
  });

  test("isErroredInPeer should return false for non-existent peers", () => {
    const [agent, sessionID] = randomAgentAndSessionID();
    const node = new LocalNode(agent.agentSecret, sessionID, Crypto);

    const coValue = node.createCoValue({
      type: "costream",
      ruleset: { type: "unsafeAllowAll" },
      meta: null,
      ...Crypto.createdNowUnique(),
    });

    const nonExistentPeerId = "non-existent-peer";

    // Verify non-existent peer is not errored
    expect(coValue.isErroredInPeer(nonExistentPeerId)).toBe(false);
  });

  test("isErroredInPeer should return false for peers with other states", () => {
    const [agent, sessionID] = randomAgentAndSessionID();
    const node = new LocalNode(agent.agentSecret, sessionID, Crypto);

    const coValue = node.createCoValue({
      type: "costream",
      ruleset: { type: "unsafeAllowAll" },
      meta: null,
      ...Crypto.createdNowUnique(),
    });

    const peerId = "test-peer-3";

    // Mark peer as pending
    coValue.markPending(peerId);
    expect(coValue.isErroredInPeer(peerId)).toBe(false);

    // Mark peer as unavailable
    coValue.markNotFoundInPeer(peerId);
    expect(coValue.isErroredInPeer(peerId)).toBe(false);
  });

  test("provideHeader should work", () => {
    const [agent, sessionID] = randomAgentAndSessionID();
    const node = new LocalNode(agent.agentSecret, sessionID, Crypto);

    const header = {
      type: "costream",
      ruleset: { type: "unsafeAllowAll" },
      meta: null,
      ...Crypto.createdNowUnique(),
    } as const;

    const coValue = node.getCoValue(idforHeader(header, Crypto));

    expect(coValue.isAvailable()).toBe(false);

    const success = coValue.provideHeader(header);
    expect(success).toBe(true);
    expect(coValue.isAvailable()).toBe(true);
  });

  test("provideHeader should return false if the header hash doesn't match the coValue id", () => {
    const [agent, sessionID] = randomAgentAndSessionID();
    const node = new LocalNode(agent.agentSecret, sessionID, Crypto);

    const header = {
      type: "costream",
      ruleset: { type: "unsafeAllowAll" },
      meta: null,
      ...Crypto.createdNowUnique(),
    } as const;

    const coValue = node.getCoValue("co_ztest123");

    expect(coValue.isAvailable()).toBe(false);

    const success = coValue.provideHeader(header);
    expect(success).toBe(false);
    expect(coValue.isAvailable()).toBe(false);
  });

  test("markErrored should work with multiple peers", () => {
    const [agent, sessionID] = randomAgentAndSessionID();
    const node = new LocalNode(agent.agentSecret, sessionID, Crypto);

    const coValue = node.createCoValue({
      type: "costream",
      ruleset: { type: "unsafeAllowAll" },
      meta: null,
      ...Crypto.createdNowUnique(),
    });

    const peer1Id = "peer-1";
    const peer2Id = "peer-2";
    const peer3Id = "peer-3";

    const error1 = {
      type: "InvalidSignature" as const,
      id: coValue.id,
      newSignature: "invalid-signature-1" as any,
      sessionID: sessionID,
      signerID: "test-signer-1" as any,
    };

    const error2 = {
      type: "InvalidHash" as const,
      id: coValue.id,
      expectedNewHash: "expected-hash-2" as any,
      givenExpectedNewHash: "given-hash-2" as any,
    };

    // Mark different peers as errored
    coValue.markErrored(peer1Id, error1);
    coValue.markErrored(peer2Id, error2);

    // Verify each peer is correctly marked as errored
    expect(coValue.isErroredInPeer(peer1Id)).toBe(true);
    expect(coValue.isErroredInPeer(peer2Id)).toBe(true);
    expect(coValue.isErroredInPeer(peer3Id)).toBe(false);
  });

  test("markErrored should override previous peer states", () => {
    const [agent, sessionID] = randomAgentAndSessionID();
    const node = new LocalNode(agent.agentSecret, sessionID, Crypto);

    const coValue = node.createCoValue({
      type: "costream",
      ruleset: { type: "unsafeAllowAll" },
      meta: null,
      ...Crypto.createdNowUnique(),
    });

    const peerId = "test-peer-4";

    // Initially mark as pending
    coValue.markPending(peerId);
    expect(coValue.isErroredInPeer(peerId)).toBe(false);

    // Then mark as errored
    const testError = {
      type: "TriedToAddTransactionsWithoutVerifiedState" as const,
      id: coValue.id,
    };

    coValue.markErrored(peerId, testError);

    // Verify the peer is now errored
    expect(coValue.isErroredInPeer(peerId)).toBe(true);

    expect(coValue.getLoadingStateForPeer(peerId)).toBe("errored");
  });

  test("markErrored should work with different error types", () => {
    const [agent, sessionID] = randomAgentAndSessionID();
    const node = new LocalNode(agent.agentSecret, sessionID, Crypto);

    const coValue = node.createCoValue({
      type: "costream",
      ruleset: { type: "unsafeAllowAll" },
      meta: null,
      ...Crypto.createdNowUnique(),
    });

    const peerId = "test-peer-5";

    // Test with InvalidSignature error
    const invalidSignatureError = {
      type: "InvalidSignature" as const,
      id: coValue.id,
      newSignature: "invalid-sig" as any,
      sessionID: sessionID,
      signerID: "test-signer" as any,
    };

    coValue.markErrored(peerId, invalidSignatureError);
    expect(coValue.isErroredInPeer(peerId)).toBe(true);

    // Test with InvalidHash error
    const invalidHashError = {
      type: "InvalidHash" as const,
      id: coValue.id,
      expectedNewHash: "expected" as any,
      givenExpectedNewHash: "given" as any,
    };

    coValue.markErrored(peerId, invalidHashError);
    expect(coValue.isErroredInPeer(peerId)).toBe(true);

    // Test with TriedToAddTransactionsWithoutVerifiedState error
    const noVerifiedStateError = {
      type: "TriedToAddTransactionsWithoutVerifiedState" as const,
      id: coValue.id,
    };

    coValue.markErrored(peerId, noVerifiedStateError);
    expect(coValue.isErroredInPeer(peerId)).toBe(true);
  });

  test("markErrored should trigger immediate notification", () => {
    const [agent, sessionID] = randomAgentAndSessionID();
    const node = new LocalNode(agent.agentSecret, sessionID, Crypto);

    const coValue = node.createCoValue({
      type: "costream",
      ruleset: { type: "unsafeAllowAll" },
      meta: null,
      ...Crypto.createdNowUnique(),
    });

    const peerId = "test-peer-6";
    const testError = {
      type: "InvalidSignature" as const,
      id: coValue.id,
      newSignature: "test-sig" as any,
      sessionID: sessionID,
      signerID: "test-signer" as any,
    };

    let notificationCount = 0;
    const listener = () => {
      notificationCount++;
    };

    coValue.subscribe(listener);

    // Mark as errored
    coValue.markErrored(peerId, testError);

    // Verify immediate notification
    expect(notificationCount).toBeGreaterThan(0);
  });
});

test("knownState should reflect modifications", () => {
  const [agent, sessionID] = randomAgentAndSessionID();
  const node = new LocalNode(agent.agentSecret, sessionID, Crypto);

  const group = node.createGroup();
  const map = group.createMap();

  // Get the knownState before any modification
  const knownState1 = map.core.knownState();

  // Now modify the CoValue by making a transaction
  map.set("hello", "world");

  // Get the knownState after modification - should have updated sessions
  const knownState2 = map.core.knownState();
  expect(knownState2).not.toEqual(knownState1);

  // Make another modification
  map.set("foo", "bar");

  // Get the knownState after second modification - should have updated sessions again
  const knownState3 = map.core.knownState();
  expect(knownState3).not.toEqual(knownState2);
  expect(knownState3).not.toEqual(knownState1);
});

describe("provideHeader uniqueness validation", () => {
  test("should reject number uniqueness", () => {
    const node = createTestNode();
    const { coValue, header } = createUnloadedCoValue(node);

    const invalidHeader = {
      ...header,
      uniqueness: 1.5 as any, // non-integer
    };

    expect(coValue.provideHeader(invalidHeader)).toBe(false);
  });

  test("should reject array uniqueness", () => {
    const node = createTestNode();
    const { coValue, header } = createUnloadedCoValue(node);

    const invalidHeader = {
      ...header,
      uniqueness: [1, 2, 3] as any,
    };

    expect(coValue.provideHeader(invalidHeader)).toBe(false);
  });

  test("should reject object uniqueness with non-string values", () => {
    const node = createTestNode();
    const { coValue, header } = createUnloadedCoValue(node);

    const invalidHeader = {
      ...header,
      uniqueness: { key: 123 } as any,
    };

    expect(coValue.provideHeader(invalidHeader)).toBe(false);
  });
});
