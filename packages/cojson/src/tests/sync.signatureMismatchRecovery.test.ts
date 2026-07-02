import { beforeEach, describe, expect, test } from "vitest";

import type { RawCoMap } from "../exports.js";
import {
  SyncMessagesLog,
  TEST_NODE_CONFIG,
  loadCoValueOrFail,
  setupTestNode,
} from "./testUtils.js";
import {
  setupRecoveryActors,
  createSharedTaskMap,
  crashAfterServerAckBeforeLocalPersist,
  expectTaskFields,
  waitForRecovery,
} from "./recoveryTestHelpers.js";

TEST_NODE_CONFIG.withAsyncPeers = true;

function blockStorageWrites(storage: { store: (...args: any[]) => any }) {
  const original = storage.store;
  storage.store = () => {};
  return {
    unblock: () => {
      storage.store = original;
    },
  };
}

function waitForCondition(
  callback: () => boolean | void,
  { retries = 50, interval = 100 } = {},
) {
  return new Promise<void>((resolve, reject) => {
    let count = 0;
    const check = () => {
      try {
        const result = callback();
        if (result !== false) {
          resolve();
          return;
        }
      } catch {
        // retry
      }
      if (++count > retries) {
        reject(new Error(`Condition not met after ${retries} retries`));
        return;
      }
      setTimeout(check, interval);
    };
    check();
  });
}

describe("signature mismatch recovery", () => {
  let jazzCloud: ReturnType<typeof setupTestNode>;

  beforeEach(() => {
    SyncMessagesLog.clear();
    jazzCloud = setupTestNode({ isSyncServer: true });
  });

  test("server sends SignatureMismatchError on divergent session", async () => {
    const client = setupTestNode();
    const { storage } = client.addStorage();
    const { peer: serverPeer } = client.connectToSyncServer();

    const group = client.node.createGroup();
    const map = group.createMap();
    map.set("a", "1", "trusting");
    await map.core.waitForSync();

    const mapId = map.id;
    const serverPeerId = serverPeer.id;

    // Block storage — next transaction syncs to server but not local storage
    const block = blockStorageWrites(storage);
    map.set("b", "2", "trusting");
    await client.node.syncManager.waitForSyncWithPeer(
      serverPeerId,
      mapId,
      5000,
    );

    client.disconnect();
    block.unblock();

    await client.restart();
    client.addStorage({ storage });

    const mapAfterRestart = (await loadCoValueOrFail(
      client.node,
      mapId,
    )) as RawCoMap;

    // Make divergent + extra tx to go past server count
    mapAfterRestart.set("c", "3", "trusting");
    mapAfterRestart.set("d", "4", "trusting");

    SyncMessagesLog.clear();
    client.connectToSyncServer();

    // Wait for the error message to appear
    await waitForCondition(() => {
      const errorMessages = SyncMessagesLog.messages.filter(
        (m) =>
          typeof m.msg === "object" &&
          "action" in m.msg &&
          m.msg.action === "error",
      );
      return errorMessages.length >= 1;
    });

    const errorMessages = SyncMessagesLog.messages.filter(
      (m) =>
        typeof m.msg === "object" &&
        "action" in m.msg &&
        m.msg.action === "error",
    );
    expect(errorMessages.length).toBe(1);

    const errorMsg = errorMessages[0]!.msg as any;
    expect(errorMsg.errorType).toBe("SignatureMismatch");
    expect(errorMsg.id).toBe(mapId);
    expect(errorMsg.content.length).toBeGreaterThan(0);
  }, 15000);

  test("server sends error only once per session (dedup)", async () => {
    const client = setupTestNode();
    const { storage } = client.addStorage();
    const { peer: serverPeer } = client.connectToSyncServer();

    const group = client.node.createGroup();
    const map = group.createMap();
    map.set("a", "1", "trusting");
    await map.core.waitForSync();

    const mapId = map.id;
    const serverPeerId = serverPeer.id;

    const block = blockStorageWrites(storage);
    map.set("b", "2", "trusting");
    await client.node.syncManager.waitForSyncWithPeer(
      serverPeerId,
      mapId,
      5000,
    );

    client.disconnect();
    block.unblock();

    await client.restart();
    client.addStorage({ storage });

    const mapAfterRestart = (await loadCoValueOrFail(
      client.node,
      mapId,
    )) as RawCoMap;
    mapAfterRestart.set("c", "3", "trusting");
    mapAfterRestart.set("d", "4", "trusting");

    SyncMessagesLog.clear();
    client.connectToSyncServer();

    await waitForCondition(() => {
      return SyncMessagesLog.messages.some(
        (m) =>
          typeof m.msg === "object" &&
          "action" in m.msg &&
          m.msg.action === "error",
      );
    });

    // Small delay to ensure no more messages arrive
    await new Promise((r) => setTimeout(r, 500));

    const errorMessages = SyncMessagesLog.messages.filter(
      (m) =>
        typeof m.msg === "object" &&
        "action" in m.msg &&
        m.msg.action === "error",
    );
    expect(errorMessages.length).toBe(1);
  }, 15000);

  test("repairs alice after crash and preserves divergent task edits", async () => {
    /**
     * Alice crashed after Jazz Cloud accepted `status="review"`
     * but before Alice persisted it locally.
     *
     * Topology
     *   Alice --------> Jazz Cloud
     *
     * Before reconnect
     *   Alice disk   : title, priority
     *   Jazz Cloud   : title, priority, status
     *
     * Expected after recovery
     *   rewritten session : title, priority, status
     *   conflict session  : assignee, archived
     *   visible map       : title, priority, status, assignee, archived
     */
    const { alice, aliceStorage } = setupRecoveryActors();
    const { mapId } = await createSharedTaskMap(alice, {
      title: "Fix login bug",
      priority: "high",
    });

    const mapAfterRestart = await crashAfterServerAckBeforeLocalPersist(
      alice,
      aliceStorage,
      mapId,
      { status: "review" },
    );

    // Create divergent local edits
    mapAfterRestart.set("assignee", "bob", "trusting");
    mapAfterRestart.set("archived", "false", "trusting");

    alice.connectToSyncServer();

    await waitForRecovery(() => {
      const content = alice.node
        .getCoValue(mapId)
        .getCurrentContent() as RawCoMap;
      return content?.get("status") === "review";
    });

    const recovered = alice.node
      .getCoValue(mapId)
      .getCurrentContent() as RawCoMap;
    expectTaskFields(recovered, {
      title: "Fix login bug",
      priority: "high",
      status: "review",
      assignee: "bob",
      archived: "false",
    });
  }, 15000);

  test("repairs alice when jazzCloud is ahead by more transactions than alice", async () => {
    /**
     * Jazz Cloud accepted both `status="review"` and `assignee="carol"`
     * but Alice's disk has neither.
     *
     * Alice makes three post-crash edits so her session is longer than
     * the server's, which triggers the SignatureMismatch error path.
     *
     * Topology
     *   Alice --------> Jazz Cloud
     *
     * Before reconnect
     *   Alice disk   : title, priority
     *   Jazz Cloud   : title, priority, status, assignee
     *
     * Expected after recovery
     *   rewritten session : title, priority, status, assignee
     *   conflict session  : archived, owner, due
     *   visible map       : title, priority, status, assignee, archived, owner, due
     */
    const { alice, aliceStorage } = setupRecoveryActors();
    const { mapId } = await createSharedTaskMap(alice, {
      title: "Fix login bug",
      priority: "high",
    });

    const mapAfterRestart = await crashAfterServerAckBeforeLocalPersist(
      alice,
      aliceStorage,
      mapId,
      { status: "review", assignee: "carol" },
    );

    // Three post-crash edits so alice's session is ahead of the server's
    mapAfterRestart.set("archived", "true", "trusting");
    mapAfterRestart.set("owner", "alice", "trusting");
    mapAfterRestart.set("due", "friday", "trusting");

    alice.connectToSyncServer();

    await waitForRecovery(() => {
      const content = alice.node
        .getCoValue(mapId)
        .getCurrentContent() as RawCoMap;
      return (
        content?.get("assignee") === "carol" &&
        content?.get("archived") === "true"
      );
    });

    const recovered = alice.node
      .getCoValue(mapId)
      .getCurrentContent() as RawCoMap;
    expectTaskFields(recovered, {
      title: "Fix login bug",
      priority: "high",
      status: "review",
      assignee: "carol",
      archived: "true",
      owner: "alice",
      due: "friday",
    });
  }, 15000);

  test("repairs alice when there are no divergent local edits to preserve", async () => {
    /**
     * Server has `status="review"` that Alice's disk lost.
     * Alice makes new (non-overlapping) edits after restart.
     *
     * Topology
     *   Alice --------> Jazz Cloud
     *
     * Before reconnect
     *   Alice disk   : (empty map)
     *   Jazz Cloud   : status
     *
     * Expected after recovery
     *   rewritten session : status
     *   conflict session  : assignee, priority
     *   visible map       : status, assignee, priority
     */
    const { alice, aliceStorage } = setupRecoveryActors();
    const { mapId } = await createSharedTaskMap(alice, {});

    const mapAfterRestart = await crashAfterServerAckBeforeLocalPersist(
      alice,
      aliceStorage,
      mapId,
      { status: "review" },
    );

    mapAfterRestart.set("assignee", "bob", "trusting");
    mapAfterRestart.set("priority", "high", "trusting");

    alice.connectToSyncServer();

    await waitForRecovery(() => {
      const content = alice.node
        .getCoValue(mapId)
        .getCurrentContent() as RawCoMap;
      return (
        content?.get("status") === "review" &&
        content?.get("assignee") === "bob"
      );
    });

    const recovered = alice.node
      .getCoValue(mapId)
      .getCurrentContent() as RawCoMap;
    expectTaskFields(recovered, {
      status: "review",
      assignee: "bob",
      priority: "high",
    });
  }, 15000);

  test("bob converges after already observing alice stale session before recovery", async () => {
    /**
     * Bob subscribed and received Alice's stale history.
     * After Alice recovers, Bob must converge to the repaired state.
     *
     * Topology
     *   Alice --------> Jazz Cloud --------> Bob
     *     ^                                   |
     *     |------------- reconnect -----------|
     *
     * Before reconnect
     *   Alice disk   : title, priority
     *   Jazz Cloud   : title, priority, status
     *   Bob          : title, priority, status
     *
     * Expected after recovery
     *   Alice visible  : title, priority, status, assignee
     *   Bob visible    : title, priority, status, assignee
     */
    const { alice, bob, aliceStorage } = setupRecoveryActors();
    const { mapId } = await createSharedTaskMap(alice, {
      title: "Fix login bug",
      priority: "high",
    });

    // Bob explicitly loads the map to subscribe to updates via jazzCloud
    await loadCoValueOrFail(bob.node, mapId);

    // Wait for Bob to receive Alice's initial state
    await waitForRecovery(() => {
      const content = bob.node
        .getCoValue(mapId)
        .getCurrentContent() as RawCoMap;
      return content?.get("title") === "Fix login bug";
    });

    // Crash: status reaches server + Bob but not Alice's disk
    const mapAfterRestart = await crashAfterServerAckBeforeLocalPersist(
      alice,
      aliceStorage,
      mapId,
      { status: "review" },
    );

    // Wait for Bob to receive the status update (propagated from alice via jazzCloud)
    await waitForRecovery(() => {
      const content = bob.node
        .getCoValue(mapId)
        .getCurrentContent() as RawCoMap;
      return content?.get("status") === "review";
    });

    // Bob should have the stale view with status
    const bobMapBefore = bob.node
      .getCoValue(mapId)
      .getCurrentContent() as RawCoMap;
    expect(bobMapBefore.get("status")).toBe("review");

    // Alice makes divergent edits (must be more than what was lost to trigger recovery)
    mapAfterRestart.set("assignee", "bob", "trusting");
    mapAfterRestart.set("archived", "false", "trusting");

    // Reconnect — triggers recovery
    alice.connectToSyncServer();

    // Alice converges
    await waitForRecovery(() => {
      const content = alice.node
        .getCoValue(mapId)
        .getCurrentContent() as RawCoMap;
      return (
        content?.get("status") === "review" &&
        content?.get("assignee") === "bob"
      );
    });

    expectTaskFields(
      alice.node.getCoValue(mapId).getCurrentContent() as RawCoMap,
      {
        title: "Fix login bug",
        priority: "high",
        status: "review",
        assignee: "bob",
      },
    );

    // Bob converges to repaired state including Alice's conflict session edits
    await waitForRecovery(() => {
      const content = bob.node
        .getCoValue(mapId)
        .getCurrentContent() as RawCoMap;
      return content?.get("assignee") === "bob";
    });

    expectTaskFields(
      bob.node.getCoValue(mapId).getCurrentContent() as RawCoMap,
      {
        title: "Fix login bug",
        priority: "high",
        status: "review",
        assignee: "bob",
      },
    );
  }, 15000);

  test("fresh charlie load after alice recovery sees only repaired history", async () => {
    /**
     * Charlie was not connected during the crash or recovery.
     * After Alice recovers, Charlie loads fresh and must see
     * only repaired state — no stale session leaks.
     *
     * Topology
     *   Alice --------> Jazz Cloud
     *                       |
     *               (after recovery)
     *                       |
     *                   Charlie (fresh load)
     *
     * Before reconnect
     *   Alice disk   : title
     *   Jazz Cloud   : title, status
     *
     * Expected after recovery
     *   Alice visible   : title, status, assignee
     *   Charlie visible : title, status, assignee
     */
    const { alice, aliceStorage } = setupRecoveryActors();
    const { mapId } = await createSharedTaskMap(alice, {
      title: "Fix login bug",
    });

    const mapAfterRestart = await crashAfterServerAckBeforeLocalPersist(
      alice,
      aliceStorage,
      mapId,
      { status: "review" },
    );

    // Divergent edits (2 edits > 1 lost transaction)
    mapAfterRestart.set("assignee", "bob", "trusting");
    mapAfterRestart.set("priority", "high", "trusting");

    alice.connectToSyncServer();

    await waitForRecovery(() => {
      const content = alice.node
        .getCoValue(mapId)
        .getCurrentContent() as RawCoMap;
      return content?.get("status") === "review";
    });

    // Charlie connects fresh after recovery
    const charlie = setupTestNode();
    charlie.addStorage();
    charlie.connectToSyncServer();

    const charlieMap = (await loadCoValueOrFail(
      charlie.node,
      mapId,
    )) as RawCoMap;
    expectTaskFields(charlieMap, {
      title: "Fix login bug",
      status: "review",
      assignee: "bob",
      priority: "high",
    });
  }, 15000);

  test("repairs alice while preserving other local sessions that did not mismatch", async () => {
    /**
     * A second session on the same agent made edits that are not
     * involved in the mismatch. Recovery should only rewrite the
     * mismatched session, not collapse unrelated sessions.
     *
     * Topology
     *   Alice(session1) --------> Jazz Cloud <-------- Alice(session2)
     *
     * Before reconnect
     *   session1 disk   : title
     *   session1 server : title, status
     *   session2        : assignee (via server)
     *
     * Expected after recovery
     *   session1 rewritten : title, status
     *   session2 preserved : assignee
     *   conflict session   : priority, archived
     *   visible map        : title, status, assignee, priority, archived
     */
    const { alice, aliceStorage } = setupRecoveryActors();
    const { mapId } = await createSharedTaskMap(alice, {
      title: "Fix login bug",
    });

    // Spawn a second session for alice's agent
    const alice2 = alice.spawnNewSession();
    alice2.addStorage();
    alice2.connectToSyncServer();

    // Second session makes edits (synced via server)
    const mapOnAlice2 = (await loadCoValueOrFail(
      alice2.node,
      mapId,
    )) as RawCoMap;
    mapOnAlice2.set("assignee", "carol", "trusting");
    await mapOnAlice2.core.waitForSync();

    // Wait for alice's original session to see session2's edits
    await waitForRecovery(() => {
      const content = alice.node
        .getCoValue(mapId)
        .getCurrentContent() as RawCoMap;
      return content?.get("assignee") === "carol";
    });

    // Now crash alice's session1
    const mapAfterRestart = await crashAfterServerAckBeforeLocalPersist(
      alice,
      aliceStorage,
      mapId,
      { status: "review" },
    );

    // Make divergent edits (more than 1 to exceed server count)
    mapAfterRestart.set("priority", "high", "trusting");
    mapAfterRestart.set("archived", "false", "trusting");

    // Reconnect — triggers recovery on session1 only
    alice.connectToSyncServer();

    await waitForRecovery(() => {
      const content = alice.node
        .getCoValue(mapId)
        .getCurrentContent() as RawCoMap;
      return content?.get("status") === "review";
    });

    const recovered = alice.node
      .getCoValue(mapId)
      .getCurrentContent() as RawCoMap;
    expectTaskFields(recovered, {
      title: "Fix login bug",
      status: "review",
      priority: "high",
      archived: "false",
    });
    // Session2's edits (assignee from alice2) should also be preserved
    expect(recovered.get("assignee")).toBe("carol");
  }, 15000);

  test.fails(
    "deleted task recovery stays tombstone-only for charlie and future sync",
    async () => {
      /**
       * KNOWN DESIGN GAP: deleted recovery may serialize historical
       * non-delete sessions to fresh peers instead of tombstone-only state.
       *
       * Alice crashes after the delete reached the server but not her disk.
       * After recovery, a fresh loader (charlie) should see only the tombstone.
       *
       * Topology
       *   Alice --------> Jazz Cloud
       *                       |
       *               (after recovery)
       *                       |
       *                   Charlie (fresh load)
       *
       * Before reconnect
       *   Alice disk   : title (no delete)
       *   Jazz Cloud   : title, delete-session
       *
       * Expected after recovery
       *   Alice: isDeleted === true
       *   Charlie: isDeleted === true (tombstone only, no historical content)
       */
      const { alice, aliceStorage } = setupRecoveryActors();

      const { mapId, map } = await createSharedTaskMap(alice, {
        title: "Fix login bug",
      });

      // Block storage, delete on server, crash
      const originalStore = aliceStorage.store.bind(aliceStorage);
      aliceStorage.store = () => {};

      map.core.deleteCoValue();

      // Wait for delete to sync to server peers
      const peers = Object.values(alice.node.syncManager.peers);
      await Promise.all(
        peers.map((peer) =>
          alice.node.syncManager.waitForSyncWithPeer(peer.id, mapId, 10_000),
        ),
      );

      alice.disconnect();
      aliceStorage.store = originalStore;

      await alice.restart();
      alice.addStorage({ storage: aliceStorage });

      const mapAfterRestart = (await loadCoValueOrFail(
        alice.node,
        mapId,
      )) as RawCoMap;

      // Make divergent txs to trigger mismatch (alice doesn't know it's deleted)
      mapAfterRestart.set("priority", "high", "trusting");
      mapAfterRestart.set("archived", "false", "trusting");

      alice.connectToSyncServer();

      await waitForRecovery(() => {
        const core = alice.node.getCoValue(mapId);
        return core.isDeleted;
      });

      // Charlie loads fresh — should see only tombstone
      const charlie = setupTestNode();
      charlie.addStorage();
      charlie.connectToSyncServer();

      // Wait for charlie to load
      await new Promise((r) => setTimeout(r, 2000));
      const charlieCore = charlie.node.getCoValue(mapId);
      expect(charlieCore.isDeleted).toBe(true);
    },
    20000,
  );
});
