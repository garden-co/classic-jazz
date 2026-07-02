/**
 * Shared helpers for recovery test layers.
 *
 * These helpers set up realistic named actors (alice, jazzCloud, bob),
 * task-map fields (title, status, assignee, priority, archived), and
 * common crash/recovery scenarios used across signature mismatch recovery tests.
 */

import type { CoID, RawCoMap, StorageAPI } from "../exports.js";
import { expect } from "vitest";
import { loadCoValueOrFail, setupTestNode } from "./testUtils.js";

// ============================================================================
// Types
// ============================================================================

export type RecoveryActors = {
  alice: ReturnType<typeof setupTestNode>;
  jazzCloud: ReturnType<typeof setupTestNode>;
  bob: ReturnType<typeof setupTestNode>;
  aliceStorage: StorageAPI;
  bobStorage: StorageAPI;
};

export type SharedTaskMap = {
  map: RawCoMap;
  mapId: CoID<RawCoMap>;
  group: ReturnType<ReturnType<typeof setupTestNode>["node"]["createGroup"]>;
};

export type TaskFields = {
  title?: string;
  status?: string;
  assignee?: string;
  priority?: string;
  archived?: string;
};

// ============================================================================
// setupRecoveryActors
// ============================================================================

/**
 * Sets up three actors: alice (client), jazzCloud (server), and bob (client).
 * Each client gets storage and is connected to jazzCloud.
 *
 * Returns actors and their storage references.
 */
export function setupRecoveryActors(): RecoveryActors {
  const jazzCloud = setupTestNode({ isSyncServer: true });

  const alice = setupTestNode();
  const { storage: aliceStorage } = alice.addStorage({ ourName: "alice" });
  alice.connectToSyncServer({ ourName: "alice", syncServerName: "jazzCloud" });

  const bob = setupTestNode();
  const { storage: bobStorage } = bob.addStorage({ ourName: "bob" });
  bob.connectToSyncServer({ ourName: "bob", syncServerName: "jazzCloud" });

  return { alice, jazzCloud, bob, aliceStorage, bobStorage };
}

// ============================================================================
// createSharedTaskMap
// ============================================================================

/**
 * Creates a shared task map on alice's node with the given fields.
 * Waits for sync to jazzCloud before returning.
 */
export async function createSharedTaskMap(
  alice: ReturnType<typeof setupTestNode>,
  fields: TaskFields = {},
): Promise<SharedTaskMap> {
  const group = alice.node.createGroup();
  const map = group.createMap();

  for (const [key, value] of Object.entries(fields)) {
    if (value !== undefined) {
      map.set(key, value, "trusting");
    }
  }

  await map.core.waitForSync();

  return {
    map,
    mapId: map.id as CoID<RawCoMap>,
    group,
  };
}

// ============================================================================
// crashAfterServerAckBeforeLocalPersist
// ============================================================================

/**
 * Simulates a crash scenario:
 * 1. Blocks alice's storage writes
 * 2. Makes transactions on the map (these reach the server but not local storage)
 * 3. Waits for sync to complete
 * 4. Disconnects alice
 * 5. Unblocks storage (crash: alice never wrote these txs locally)
 * 6. Restarts alice from disk
 * 7. Re-attaches the same storage object
 * 8. Loads and returns the map from disk (missing the lost transactions)
 */
export async function crashAfterServerAckBeforeLocalPersist(
  alice: ReturnType<typeof setupTestNode>,
  aliceStorage: StorageAPI,
  mapId: CoID<RawCoMap>,
  transactionsToLose: Record<string, string>,
): Promise<RawCoMap> {
  // Block storage writes — transactions will sync to server but not persist locally
  const originalStore = aliceStorage.store.bind(aliceStorage);
  aliceStorage.store = () => {};

  // Apply the transactions (these will go to the server)
  const map = alice.node.getCoValue(mapId).getCurrentContent() as RawCoMap;
  for (const [key, value] of Object.entries(transactionsToLose)) {
    map.set(key, value, "trusting");
  }

  // Wait for sync to complete with server peers only (storage is blocked).
  // We use waitForSyncWithPeer for each connected peer rather than
  // waitForSync (which also waits for storage and would deadlock here).
  const peers = Object.values(alice.node.syncManager.peers);
  await Promise.all(
    peers.map((peer) =>
      alice.node.syncManager.waitForSyncWithPeer(peer.id, mapId, 10_000),
    ),
  );

  // Disconnect alice (simulates crash / network loss)
  alice.disconnect();

  // Unblock storage (the crash happened; disk never got the transactions)
  aliceStorage.store = originalStore;

  // Restart alice — loads from disk (missing the lost transactions)
  await alice.restart();
  alice.addStorage({ storage: aliceStorage });

  // Load the map from the restarted node
  const mapAfterRestart = (await loadCoValueOrFail(
    alice.node,
    mapId,
  )) as RawCoMap;

  return mapAfterRestart;
}

// ============================================================================
// expectTaskFields
// ============================================================================

/**
 * Asserts that a RawCoMap contains the expected field values.
 * Pass `undefined` for a field to assert it is absent.
 */
export function expectTaskFields(
  map: RawCoMap,
  expected: TaskFields & { [key: string]: string | undefined },
): void {
  for (const [key, value] of Object.entries(expected)) {
    if (value === undefined) {
      expect(map.get(key)).toBeUndefined();
    } else {
      expect(map.get(key)).toBe(value);
    }
  }
}

// ============================================================================
// waitForRecovery
// ============================================================================

/**
 * Polls a condition every 100ms for up to 5 seconds (50 retries).
 * The condition function should return true (or not throw) when the expected
 * state has been reached.
 *
 * Useful for waiting for async recovery operations like session replacement.
 */
export function waitForRecovery(
  condition: () => boolean | void,
  opts: { retries?: number; interval?: number } = {},
): Promise<void> {
  const { retries = 50, interval = 100 } = opts;

  return new Promise<void>((resolve, reject) => {
    let count = 0;

    const check = () => {
      try {
        const result = condition();
        if (result !== false) {
          resolve();
          return;
        }
      } catch {
        // condition threw — treat as not yet met, retry
      }

      if (++count >= retries) {
        reject(
          new Error(
            `waitForRecovery: condition not met after ${retries} retries (${retries * interval}ms)`,
          ),
        );
        return;
      }

      setTimeout(check, interval);
    };

    check();
  });
}
