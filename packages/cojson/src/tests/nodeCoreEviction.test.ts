import { describe, expect, test } from "vitest";
import { loadCoValueOrFail, setupTestNode } from "./testUtils.js";

// Eviction of the NodeCore registry entry is deferred to the next microtask
// (past any pending LocalTransactionsSyncQueue batch, which must still be able
// to read the entry to persist local transactions). Flush before asserting.
const flushMicrotasks = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("NodeCore eviction", () => {
  test("internalDeleteCoValue removes the registry entry", async () => {
    const { node } = setupTestNode();
    const group = node.createGroup();
    const map = group.createMap();

    expect(node.nodeCore.hasCoValue(map.id)).toBe(true);
    const before = node.nodeCore.coValueCount();

    node.internalDeleteCoValue(map.id);
    await flushMicrotasks();

    expect(node.nodeCore.hasCoValue(map.id)).toBe(false);
    expect(node.nodeCore.coValueCount()).toBe(before - 1);
    // double delete is a no-op (removeCoValue is a no-op when absent)
    node.internalDeleteCoValue(map.id);
    await flushMicrotasks();
  });

  test("internalUnmountCoValue removes the registry entry", async () => {
    // Unmount preconditions (no listeners, no in-memory dependants, synced to
    // server peers) are met by the same client/server setup as
    // sync.concurrentLoad.test.ts:1048 — content created on the sync server,
    // primed on the client via loadCoValueOrFail, then unmounted there.
    const jazzCloud = setupTestNode({ isSyncServer: true });
    const client = setupTestNode({ connected: false });
    client.connectToSyncServer();

    const group = jazzCloud.node.createGroup();
    const map = group.createMap();
    map.set("key", "value", "trusting");

    await loadCoValueOrFail(client.node, map.id);

    expect(client.node.nodeCore.hasCoValue(map.id)).toBe(true);

    const unmounted = client.node.internalUnmountCoValue(map.id);
    expect(unmounted).toBe(true);
    await flushMicrotasks();
    expect(client.node.nodeCore.hasCoValue(map.id)).toBe(false);

    // The shell left in node.coValues must not resurrect a registry entry:
    // getCoValue only returns the existing shell, it does not build a
    // VerifiedState, so nodeCore must stay empty for this id.
    client.node.getCoValue(map.id);
    expect(client.node.nodeCore.hasCoValue(map.id)).toBe(false);
  });

  test("re-registration after unmount goes through VerifiedState creation", async () => {
    const jazzCloud = setupTestNode({ isSyncServer: true });
    const client = setupTestNode({ connected: false });
    client.connectToSyncServer();

    const group = jazzCloud.node.createGroup();
    const map = group.createMap();
    map.set("key", "value", "trusting");

    await loadCoValueOrFail(client.node, map.id);

    const unmounted = client.node.internalUnmountCoValue(map.id);
    expect(unmounted).toBe(true);
    await flushMicrotasks();
    expect(client.node.nodeCore.hasCoValue(map.id)).toBe(false);

    // Reload the CoValue's contents from the peer — same mechanism the
    // concurrent-load test uses post-unmount (loadCoValueCore). Re-providing
    // the header constructs a fresh VerifiedState, whose constructor calls
    // nodeCore.createCoValue (replace semantics), so the registry entry must
    // be back.
    await client.node.loadCoValueCore(map.id);
    expect(client.node.nodeCore.hasCoValue(map.id)).toBe(true);
  });

  test("gracefulShutdown keeps registry entries readable for in-flight work", async () => {
    // Regression: gracefulShutdown must NOT empty the NodeCore registry. Sync
    // messages can still be processed after shutdown begins (a LOAD queued
    // before shutdown, or one arriving before a peer is fully torn down). The
    // handler path LOAD -> sendNewContent -> CoValueCore.newContentSince ->
    // VerifiedState.getSessions -> getSessionIds reads session state out of the
    // registry; if the entry had been dropped, an otherwise-available
    // CoValueCore would throw "Unknown CoValue". The per-node registry (and its
    // native SessionMaps) is released wholesale when the node is dropped, so
    // eager eviction here is both unnecessary and unsafe.
    const { node } = setupTestNode();
    const group = node.createGroup();
    const map = group.createMap();

    expect(node.nodeCore.hasCoValue(map.id)).toBe(true);

    await node.gracefulShutdown();

    // Entry survives shutdown and session reads still work.
    expect(node.nodeCore.hasCoValue(map.id)).toBe(true);
    expect(() => node.nodeCore.getSessionIds(map.id)).not.toThrow();

    // The exact path that regressed: an available CoValueCore serving a LOAD
    // after shutdown computes newContentSince, which reads its sessions.
    const core = node.getCoValue(map.id);
    expect(core.isAvailable()).toBe(true);
    expect(() => core.newContentSince(undefined)).not.toThrow();
  });
});
