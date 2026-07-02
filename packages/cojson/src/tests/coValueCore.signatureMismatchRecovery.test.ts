import { describe, expect, test } from "vitest";

import type { CoID, RawCoMap } from "../exports.js";
import { isConflictSessionID, isDeleteSessionID } from "../ids.js";
import {
  loadCoValueOrFail,
  setupTestNode,
  TEST_NODE_CONFIG,
} from "./testUtils.js";

TEST_NODE_CONFIG.withAsyncPeers = true;

describe("replaceSessionContent core invariants", () => {
  test("replaceSessionContent rewrites only the targeted session", async () => {
    /**
     * alice creates a map with title and status.
     * bob makes a separate edit (assignee) via the server.
     * Both sync. Then we get authoritative content for alice's session from the
     * server and call replaceSessionContent on alice's local core.
     *
     * Expected: title, status, and assignee are all present after replacement.
     * Bob's session is not affected.
     */
    const jazzCloud = setupTestNode({ isSyncServer: true });

    const alice = setupTestNode();
    alice.addStorage();
    alice.connectToSyncServer();

    const bob = setupTestNode();
    bob.addStorage();
    bob.connectToSyncServer();

    // Alice creates the map with everyone as a writer so bob can edit
    const group = alice.node.createGroup();
    group.addMember("everyone", "writer");
    const map = group.createMap();
    map.set("title", "Fix login bug", "trusting");
    map.set("status", "draft", "trusting");
    await map.core.waitForSync();

    const mapId = map.id as CoID<RawCoMap>;
    const aliceSessionID = alice.node.currentSessionID;

    // Bob loads and edits the map
    const bobMap = (await loadCoValueOrFail(bob.node, mapId)) as RawCoMap;
    bobMap.set("assignee", "bob", "trusting");
    await bobMap.core.waitForSync();

    // Wait for alice to see bob's edit
    await new Promise<void>((resolve, reject) => {
      let attempts = 0;
      const check = () => {
        const content = alice.node
          .getCoValue(mapId)
          .getCurrentContent() as RawCoMap;
        if (content?.get("assignee") === "bob") {
          resolve();
          return;
        }
        if (++attempts > 50) {
          reject(new Error("alice never received bob's edit"));
          return;
        }
        setTimeout(check, 100);
      };
      check();
    });

    // Get authoritative content from jazzCloud for alice's session
    const serverCore = jazzCloud.node.getCoValue(mapId);
    const authContent =
      serverCore.verified!.getFullSessionContent(aliceSessionID);
    expect(authContent.length).toBeGreaterThan(0);

    // Call replaceSessionContent on alice's local core
    const aliceCore = alice.node.getCoValue(mapId);
    aliceCore.replaceSessionContent(aliceSessionID, authContent);

    // Verify that alice's content still has title and assignee
    const aliceContent = aliceCore.getCurrentContent() as RawCoMap;
    expect(aliceContent.get("title")).toBe("Fix login bug");
    expect(aliceContent.get("status")).toBe("draft");
    expect(aliceContent.get("assignee")).toBe("bob");
  }, 15000);

  test("replaceSessionContent preserves unrelated sessions exactly", async () => {
    /**
     * alice and bob both have edits. We record bob's session state before
     * replacing alice's session. After replacement, bob's session must be
     * identical (same transaction count and lastSignature).
     */
    const jazzCloud = setupTestNode({ isSyncServer: true });

    const alice = setupTestNode();
    alice.addStorage();
    alice.connectToSyncServer();

    const bob = setupTestNode();
    bob.addStorage();
    bob.connectToSyncServer();

    // Alice creates the map with everyone as a writer so bob can edit
    const group = alice.node.createGroup();
    group.addMember("everyone", "writer");
    const map = group.createMap();
    map.set("title", "Fix login bug", "trusting");
    map.set("status", "draft", "trusting");
    await map.core.waitForSync();

    const mapId = map.id as CoID<RawCoMap>;
    const aliceSessionID = alice.node.currentSessionID;
    const bobSessionID = bob.node.currentSessionID;

    // Bob loads and edits the map
    const bobMap = (await loadCoValueOrFail(bob.node, mapId)) as RawCoMap;
    bobMap.set("assignee", "bob", "trusting");
    await bobMap.core.waitForSync();

    // Wait for alice to see bob's edit
    await new Promise<void>((resolve, reject) => {
      let attempts = 0;
      const check = () => {
        const content = alice.node
          .getCoValue(mapId)
          .getCurrentContent() as RawCoMap;
        if (content?.get("assignee") === "bob") {
          resolve();
          return;
        }
        if (++attempts > 50) {
          reject(new Error("alice never received bob's edit"));
          return;
        }
        setTimeout(check, 100);
      };
      check();
    });

    // Record bob's session state BEFORE replacement
    const aliceCore = alice.node.getCoValue(mapId);
    const bobSessionBefore = aliceCore.verified!.getSession(bobSessionID);
    expect(bobSessionBefore).toBeDefined();
    const bobTxCountBefore = bobSessionBefore!.transactions.length;
    const bobLastSigBefore = bobSessionBefore!.lastSignature;

    // Get authoritative content for alice's session and replace it
    const serverCore = jazzCloud.node.getCoValue(mapId);
    const authContent =
      serverCore.verified!.getFullSessionContent(aliceSessionID);
    aliceCore.replaceSessionContent(aliceSessionID, authContent);

    // Bob's session must be identical after replacement
    const bobSessionAfter = aliceCore.verified!.getSession(bobSessionID);
    expect(bobSessionAfter).toBeDefined();
    expect(bobSessionAfter!.transactions.length).toBe(bobTxCountBefore);
    expect(bobSessionAfter!.lastSignature).toBe(bobLastSigBefore);
  }, 15000);

  test("replaceSessionContent with no divergent local edits does not create extra serialized content", async () => {
    /**
     * alice creates a map and syncs. Server and client have identical content.
     * We get authoritative content from the server (same as what alice has) and
     * call replaceSessionContent.
     *
     * Expected: no conflict sessions (replaceSessionContent itself does not
     * create conflict sessions — that is done by the recovery flow in
     * recovery/index.ts). Map content should be intact.
     */
    const jazzCloud = setupTestNode({ isSyncServer: true });

    const alice = setupTestNode();
    alice.addStorage();
    alice.connectToSyncServer();

    // Alice creates the map and syncs
    const group = alice.node.createGroup();
    const map = group.createMap();
    map.set("title", "Fix login bug", "trusting");
    map.set("status", "draft", "trusting");
    await map.core.waitForSync();

    const mapId = map.id as CoID<RawCoMap>;
    const aliceSessionID = alice.node.currentSessionID;

    // Get authoritative content from server (identical to what alice already has)
    const serverCore = jazzCloud.node.getCoValue(mapId);
    const authContent =
      serverCore.verified!.getFullSessionContent(aliceSessionID);
    expect(authContent.length).toBeGreaterThan(0);

    // Call replaceSessionContent — server has the same content as alice
    const aliceCore = alice.node.getCoValue(mapId);
    aliceCore.replaceSessionContent(aliceSessionID, authContent);

    // No conflict sessions should exist (replaceSessionContent doesn't create them)
    const sessionIds: string[] = [];
    for (const [sid] of aliceCore.verified!.sessionEntries()) {
      sessionIds.push(sid);
    }
    const conflictSessions = sessionIds.filter(isConflictSessionID);
    expect(conflictSessions).toHaveLength(0);

    // Map content should be intact
    const content = aliceCore.getCurrentContent() as RawCoMap;
    expect(content.get("title")).toBe("Fix login bug");
    expect(content.get("status")).toBe("draft");
  }, 15000);

  test("recovered deleted state marks the rebuilt value as deleted for serialization", async () => {
    /**
     * alice creates a map, sets title, syncs, then deletes the coValue.
     * After replaceSessionContent on alice's regular session, the delete session
     * must still be present and core.isDeleted must remain true.
     */
    const jazzCloud = setupTestNode({ isSyncServer: true });

    const alice = setupTestNode();
    alice.addStorage();
    alice.connectToSyncServer();

    const group = alice.node.createGroup();
    const map = group.createMap();
    map.set("title", "Fix login bug", "trusting");
    await map.core.waitForSync();

    const mapId = map.id as CoID<RawCoMap>;
    const aliceSessionID = alice.node.currentSessionID;

    // Delete the coValue (requires admin — createGroup() gives admin to creator)
    map.core.deleteCoValue();
    expect(map.core.isDeleted).toBe(true);

    // Sync the deletion to the server
    await map.core.waitForSync();

    // Get authoritative content from server for alice's regular session
    const serverCore = jazzCloud.node.getCoValue(mapId);
    const authContent =
      serverCore.verified!.getFullSessionContent(aliceSessionID);
    expect(authContent.length).toBeGreaterThan(0);

    // Call replaceSessionContent on alice's local core
    const aliceCore = alice.node.getCoValue(mapId);
    aliceCore.replaceSessionContent(aliceSessionID, authContent);

    // isDeleted must still be true after replacement
    expect(aliceCore.isDeleted).toBe(true);

    // At least one session must be a delete session
    const sessionIds: string[] = [];
    for (const [sid] of aliceCore.verified!.sessionEntries()) {
      sessionIds.push(sid);
    }
    expect(sessionIds.some((sid) => isDeleteSessionID(sid as any))).toBe(true);
  }, 15000);

  test("newContentSince after deleted recovery emits tombstone-only content", async () => {
    /**
     * After replacing a session on a deleted coValue, newContentSince(undefined)
     * should return content that includes the delete session.
     */
    const jazzCloud = setupTestNode({ isSyncServer: true });

    const alice = setupTestNode();
    alice.addStorage();
    alice.connectToSyncServer();

    const group = alice.node.createGroup();
    const map = group.createMap();
    map.set("title", "Fix login bug", "trusting");
    await map.core.waitForSync();

    const mapId = map.id as CoID<RawCoMap>;
    const aliceSessionID = alice.node.currentSessionID;

    // Delete the coValue
    map.core.deleteCoValue();
    await map.core.waitForSync();

    // Get authoritative content from server for alice's regular session
    const serverCore = jazzCloud.node.getCoValue(mapId);
    const authContent =
      serverCore.verified!.getFullSessionContent(aliceSessionID);

    // Call replaceSessionContent on alice's local core
    const aliceCore = alice.node.getCoValue(mapId);
    aliceCore.replaceSessionContent(aliceSessionID, authContent);

    // newContentSince(undefined) should return defined, non-empty array
    const contentMessages = aliceCore.newContentSince(undefined);
    expect(contentMessages).toBeDefined();
    expect(contentMessages!.length).toBeGreaterThan(0);

    // At least one content message must have a delete session key (ending with $)
    const hasDeleteSession = contentMessages!.some((msg) =>
      Object.keys(msg.new).some((key) => isDeleteSessionID(key as any)),
    );
    expect(hasDeleteSession).toBe(true);
  }, 15000);
});
