import {
  assert,
  beforeEach,
  describe,
  expect,
  onTestFinished,
  test,
  vi,
} from "vitest";
import {
  createTestNode,
  setupTestNode,
  loadCoValueOrFail,
  setupTestAccount,
  waitFor,
} from "./testUtils.js";
import { expectList, expectMap, expectPlainText } from "../coValue.js";
import { RawAccount, RawCoMap } from "../exports.js";

let jazzCloud: ReturnType<typeof setupTestNode>;

beforeEach(async () => {
  jazzCloud = setupTestNode({ isSyncServer: true });
});

describe("Branching Logic", () => {
  describe("Branch Operations with Transactions", () => {
    test("should maintain separate transaction histories between original and branch", async () => {
      const node = createTestNode();
      const group = node.createGroup();
      const originalMap = group.createMap();
      const branchName = "feature-branch";

      // Add initial transactions to original map
      originalMap.set("originalKey1", "value1", "trusting");
      originalMap.set("originalKey2", "value2", "trusting");

      const branch = expectMap(
        originalMap.core.createBranch(branchName, group.id).getCurrentContent(),
      );

      // Add new transactions to branch
      branch.set("branchKey1", "branchValue1", "trusting");
      branch.set("branchKey2", "branchValue2", "trusting");

      // Verify original map doesn't have branch transactions
      expect(originalMap.get("branchKey1")).toBe(undefined);
      expect(originalMap.get("branchKey2")).toBe(undefined);

      // Verify branch has both original and new transactions
      expect(branch.get("branchKey2")).toBe("branchValue2");
      expect(branch.get("branchKey1")).toBe("branchValue1");
      expect(branch.get("originalKey1")).toBe("value1");
      expect(branch.get("originalKey2")).toBe("value2");
    });
  });

  describe("Branch Merging", () => {
    test("should merge branch transactions back to source map", () => {
      const node = createTestNode();
      const group = node.createGroup();
      const originalMap = group.createMap();
      const branchName = "feature-branch";

      // Add initial transactions to original map
      originalMap.set("key1", "value1", "trusting");
      originalMap.set("key2", "value2", "trusting");

      // Create branch from original map
      const branch = expectMap(
        originalMap.core.createBranch(branchName, group.id).getCurrentContent(),
      );

      // Add new transaction to branch
      branch.set("key1", "branchValue1", "trusting");

      // Merge branch back to source
      const result = expectMap(branch.core.mergeBranch().getCurrentContent());

      // Verify source now contains branch transactions
      expect(result.get("key1")).toBe("branchValue1");
      expect(result.get("key2")).toBe("value2");
    });

    test("should not create duplicate merge commits when merging already merged branch", () => {
      const node = createTestNode();
      const group = node.createGroup();
      const originalMap = group.createMap();
      const branchName = "feature-branch";

      // Add initial transactions to original map
      originalMap.set("key1", "value1", "trusting");
      originalMap.set("key2", "value2", "trusting");

      // Create branch from original map
      const branch = expectMap(
        originalMap.core.createBranch(branchName, group.id).getCurrentContent(),
      );

      // Add new transaction to branch
      branch.set("key1", "branchValue1", "trusting");

      // Merge branch twice - second merge should not create new commit
      expectMap(branch.core.mergeBranch().getCurrentContent());

      const knownState = originalMap.core.knownState();

      expectMap(branch.core.mergeBranch().getCurrentContent());

      // Verify the known state is the same
      expect(originalMap.core.knownState()).toEqual(knownState);

      // Verify source contains branch transactions
      expect(originalMap.get("key1")).toBe("branchValue1");
      expect(originalMap.get("key2")).toBe("value2");

      // Verify only one merge commit was created
      expect(originalMap.core.mergeCommits.length).toBe(1);
    });

    test("should not create merge commit when merging empty branch", () => {
      const node = createTestNode();
      const group = node.createGroup();
      const originalMap = group.createMap();
      const branchName = "feature-branch";

      // Add initial transactions to original map
      originalMap.set("key1", "value1", "trusting");
      originalMap.set("key2", "value2", "trusting");

      // Create branch from original map (no changes made)
      const branch = expectMap(
        originalMap.core.createBranch(branchName, group.id).getCurrentContent(),
      );

      // Merge empty branch
      expectMap(branch.core.mergeBranch().getCurrentContent());

      // Verify no merge commit was created
      expect(originalMap.core.mergeCommits.length).toBe(0);
    });

    test("should merge only new changes from branch after previous merge", () => {
      const node = createTestNode();
      const group = node.createGroup();
      const originalMap = group.createMap();
      const branchName = "feature-branch";

      // Add initial transactions to original map
      originalMap.set("key1", "value1", "trusting");
      originalMap.set("key2", "value2", "trusting");

      const branch = expectMap(
        originalMap.core.createBranch(branchName, group.id).getCurrentContent(),
      );

      // Add first change to branch
      branch.set("key1", "branchValue1", "trusting");

      // Merge first change
      branch.core.mergeBranch();

      // Verify first change was merged
      expect(originalMap.get("key1")).toBe("branchValue1");
      expect(originalMap.get("key2")).toBe("value2");

      // Add second change to branch
      branch.set("key2", "branchValue2", "trusting");

      // Merge second change
      branch.core.mergeBranch();

      // Verify two merge commits exist. `originalMap` is a plain (non-group)
      // coMap, so its content is fed by the native materializer (R3 stage-2b),
      // which never populates the TS-only `mergeCommits` field directly — use
      // the self-healing `getMergeCommits()` accessor (which triggers the
      // lazy TS-side meta parse) rather than the raw field.
      expect(originalMap.core.getMergeCommits().length).toBe(2);

      // Verify both changes are now in original map
      expect(originalMap.get("key1")).toBe("branchValue1");
      expect(originalMap.get("key2")).toBe("branchValue2");
    });

    test("should work with co.list", () => {
      const node = createTestNode();
      const group = node.createGroup();
      const list = group.createList();

      // Create a shopping list with grocery items
      list.appendItems(["bread", "milk", "eggs"]);

      // Remove milk from the list
      list.delete(list.asArray().indexOf("milk"));

      const branch = expectList(
        list.core.createBranch("feature-branch", group.id).getCurrentContent(),
      );

      // Add more items to the branch
      branch.appendItems(["cheese", "yogurt", "bananas"]);

      // Remove yogurt from the branch
      branch.delete(branch.asArray().indexOf("yogurt"));

      const result = expectList(branch.core.mergeBranch().getCurrentContent());

      expect(result.toJSON()).toEqual(["bread", "eggs", "cheese", "bananas"]);
    });

    test("should work with co.list when branching from different session", async () => {
      const client = setupTestNode({
        connected: true,
      });
      const group = client.node.createGroup();
      const list = group.createList();

      // Create a grocery list with initial items
      list.appendItems(["bread", "milk"]);

      const branch1 = expectList(
        list.core.createBranch("feature-branch", group.id).getCurrentContent(),
      );

      // Add new items to first branch
      branch1.appendItems(["cheese"]);

      const branch2 = expectList(
        list.core
          .createBranch("feature-branch-2", group.id)
          .getCurrentContent(),
      );

      await new Promise((resolve) => setTimeout(resolve, 5));

      // Add different items to second branch
      branch2.appendItems(["apples", "oranges", "carrots"]);

      const anotherSession = client.spawnNewSession();

      const loadedBranch2 = await loadCoValueOrFail(
        anotherSession.node,
        branch2.id,
      );

      // Add more items and remove some existing ones
      loadedBranch2.appendItems(["tomatoes", "lettuce", "cucumber"]);
      loadedBranch2.delete(loadedBranch2.asArray().indexOf("lettuce"));
      loadedBranch2.delete(loadedBranch2.asArray().indexOf("milk"));

      loadedBranch2.core.mergeBranch();

      await loadedBranch2.core.waitForSync();
      await new Promise((resolve) => setTimeout(resolve, 5));

      branch1.core.mergeBranch();

      expect(list.toJSON()).toEqual([
        "bread",
        "apples",
        "oranges",
        "carrots",
        "tomatoes",
        "cucumber",
        "cheese",
      ]);
    });

    test("should work with co.plainText when merging the same branch twice on different sessions", async () => {
      const client = setupTestNode({
        connected: true,
      });
      const group = client.node.createGroup();
      const plainText = group.createPlainText();

      plainText.insertAfter(0, "hello");

      const branch = expectPlainText(
        plainText.core
          .createBranch("feature-branch", group.id)
          .getCurrentContent(),
      );

      branch.insertAfter("hello".length, " world");

      const anotherSession = client.spawnNewSession();

      const loadedBranch = await loadCoValueOrFail(
        anotherSession.node,
        branch.id,
      );
      assert(loadedBranch);

      anotherSession.connectToSyncServer().peerState.gracefulShutdown();

      // Add more items to the branch
      loadedBranch.insertAfter("hello world".length, " people");

      branch.core.mergeBranch();
      const loadedBranchMergeResult = loadedBranch.core.mergeBranch();

      anotherSession.connectToSyncServer();
      await loadedBranchMergeResult.waitForSync();

      expect(plainText.toString()).toEqual("hello world people");
    });

    test("should preserve the conflict resolution that was applied to the branch", async () => {
      const dateNowMock = vi.spyOn(Date, "now");

      dateNowMock.mockReturnValue(1);

      const client = setupTestNode({
        connected: true,
      });
      const group = client.node.createGroup();
      const map = group.createMap();
      const branchName = "feature-branch";

      onTestFinished(() => {
        dateNowMock.mockRestore();
      });

      // Add initial transactions to original map
      map.set("value", 1, "trusting");

      // Create branch from original map
      const branch = expectMap(
        map.core.createBranch(branchName, group.id).getCurrentContent(),
      );

      dateNowMock.mockReturnValue(2);

      // Add new transaction to branch
      branch.set("value", 2, "trusting");

      const newSession = client.spawnNewSession();

      const loadedBranch = await loadCoValueOrFail(newSession.node, branch.id);

      dateNowMock.mockReturnValue(3);

      loadedBranch.set("value", 3, "trusting");

      expect(loadedBranch.get("value")).toBe(3);

      await loadedBranch.core.waitForSync();

      // Push back the change, so it doesn't win the conflict
      dateNowMock.mockReturnValue(1);

      branch.set("value", 4, "trusting");

      expect(branch.get("value")).toBe(3);

      dateNowMock.mockReturnValue(4);
      branch.core.mergeBranch();

      // The conflict resolution should be preserved, so we should have 3 and not 4
      expect(map.get("value")).toBe(3);
    });

    test("should preserve the original madeAt of the branch", async () => {
      const client = setupTestNode();
      const group = client.node.createGroup();
      const map = group.createMap();

      // Add initial transactions to original map
      map.set("value", 1, "trusting");

      // Create branch from original map
      const branch = expectMap(
        map.core.createBranch("feature-branch", group.id).getCurrentContent(),
      );

      // Add new transaction to branch
      branch.set("value", 2, "trusting");

      await new Promise((resolve) => setTimeout(resolve, 5));

      const result = branch.core.mergeBranch();

      // The merge should be successful
      expect(map.get("value")).toBe(2);

      const lastBranchTransaction = branch.core
        .getValidSortedTransactions()
        .at(-1);
      const lastMapTransaction = result
        .getValidSortedTransactions()
        .findLast((tx) => tx.txID.branch === branch.id);

      expect(lastMapTransaction?.currentMadeAt).not.toBe(
        lastMapTransaction?.madeAt,
      );

      expect(lastBranchTransaction?.madeAt).toBe(lastMapTransaction?.madeAt);
    });

    test("should not load the merged transactions into the branch (regression test)", async () => {
      const client = setupTestNode();
      const group = client.node.createGroup();
      const map = group.createMap();

      // Add initial transactions to original map
      map.set("value", 1, "trusting");

      // Create branch from original map
      const branch = expectMap(
        map.core.createBranch("feature-branch", group.id).getCurrentContent(),
      );

      await new Promise((resolve) => setTimeout(resolve, 5));

      // Add new transaction to branch
      branch.set("value", 2, "trusting");

      await new Promise((resolve) => setTimeout(resolve, 5));

      const result = branch.core.mergeBranch();

      // The merge should be successful
      expect(map.get("value")).toBe(2);

      const lastBranchTransaction = branch.core
        .getValidSortedTransactions()
        .at(-1);
      expect(lastBranchTransaction?.madeAt).toBe(
        lastBranchTransaction?.currentMadeAt,
      );

      const lastMapTransaction = result
        .getValidSortedTransactions()
        .findLast((tx) => tx.txID.branch === branch.id);
      expect(lastMapTransaction?.madeAt).not.toBe(
        lastMapTransaction?.currentMadeAt,
      );
    });

    test("write permissions should be validated against the time of the merge and not the original madeAt", async () => {
      const alice = setupTestNode({
        connected: true,
      });
      const bob = await setupTestAccount({
        connected: true,
      });
      const group = alice.node.createGroup();
      const map = group.createMap();
      const branchName = "feature-branch";

      map.set("value", 1, "trusting");

      const branch = expectMap(
        map.core.createBranch(branchName, group.id).getCurrentContent(),
      );

      branch.set("value", 2, "trusting");

      await new Promise((resolve) => setTimeout(resolve, 5));

      // Grant writer rights to bob after the changes inside the branche
      group.addMember(
        await loadCoValueOrFail(alice.node, bob.accountID),
        "writer",
      );

      const loadedBranch = await loadCoValueOrFail(bob.node, branch.id);

      // Bob merges the branch
      const mergeResult = loadedBranch.core.mergeBranch();

      // The merge should be successful
      expect(expectMap(mergeResult.getCurrentContent()).get("value")).toBe(2);
    });

    test("should reject edits from kicked out member even with timestamp manipulation", async () => {
      const alice = setupTestNode({
        connected: true,
      });
      const bob = await setupTestAccount({
        connected: true,
      });
      const group = alice.node.createGroup();
      const map = group.createMap();

      group.addMember(
        await loadCoValueOrFail(alice.node, bob.accountID),
        "writer",
      );
      const timeOnInvitation = Date.now();

      const bobMap = await loadCoValueOrFail(bob.node, map.id);

      bobMap.set("value", 1, "trusting");

      await bobMap.core.waitForSync();

      const bobGroup = bob.node.createGroup();
      const branch = expectMap(
        bobMap.core
          .createBranch("feature-branch", bobGroup.id)
          .getCurrentContent(),
      );

      await new Promise((resolve) => setTimeout(resolve, 5));

      // Alice sets value to 2 and downgrade bob to reader
      map.set("value", 2, "trusting");
      group.addMember(
        await loadCoValueOrFail(alice.node, bob.accountID),
        "reader",
      );

      await new Promise((resolve) => setTimeout(resolve, 5));

      branch.set("value", 3, "trusting");

      // Bob attempts to make an edit after being kicked out by modifying the merge time
      const dateNowMock = vi.spyOn(Date, "now");
      dateNowMock.mockReturnValue(timeOnInvitation + 1);

      const mergeResult = branch.core.mergeBranch();

      dateNowMock.mockRestore();

      // Wait for the full sync to complete
      await waitFor(() => {
        expect(mergeResult.knownState().sessions).toEqual(
          map.core.knownState().sessions,
        );
      });

      expect(expectMap(map.core.getCurrentContent()).get("value")).toBe(2);
    });

    test("should alias the txID when a transaction comes from a merge", async () => {
      const client = setupTestNode({
        connected: true,
      });
      const group = client.node.createGroup();
      const map = group.createMap();

      map.set("key", "value");

      const branch = map.core
        .createBranch("feature-branch", group.id)
        .getCurrentContent() as RawCoMap;
      branch.set("branchKey", "branchValue");

      const originalTxID = branch.core
        .getValidTransactions({
          skipBranchSource: true,
          ignorePrivateTransactions: false,
        })
        .at(-1)?.txID;

      branch.core.mergeBranch();

      map.set("key2", "value2");

      const validSortedTransactions = map.core.getValidSortedTransactions();

      // Only the merged transaction should have the txId changed
      const mergedTransactionIdx = validSortedTransactions.findIndex(
        (tx) => tx.txID.branch,
      );

      expect(
        validSortedTransactions[mergedTransactionIdx - 1]?.txID.branch,
      ).toBe(undefined);
      expect(validSortedTransactions[mergedTransactionIdx]?.txID).toEqual(
        originalTxID,
      );
      expect(
        validSortedTransactions[mergedTransactionIdx + 1]?.txID.branch,
      ).toBe(undefined);
    });
  });

  describe("Branching permissions", () => {
    test("should allow the creation of private branches to accounts with read access to the source group", async () => {
      const alice = setupTestNode({
        connected: true,
      });
      const bob = await setupTestAccount({
        connected: true,
      });
      const group = alice.node.createGroup();
      group.addMember(
        await loadCoValueOrFail(alice.node, bob.accountID),
        "reader",
      );
      const map = group.createMap();
      map.set("key", "alice");

      const bobGroup = bob.node.createGroup();

      const mapOnBob = await loadCoValueOrFail(bob.node, map.id);

      const branch = expectMap(
        mapOnBob.core
          .createBranch("feature-branch", bobGroup.id)
          .getCurrentContent(),
      );

      expect(mapOnBob.core.branches).toEqual([
        {
          branch: "feature-branch",
          ownerId: bobGroup.id,
        },
      ]);

      expect(branch.id).not.toBe(map.id);
      expect(branch.get("key")).toBe("alice");
      expect(branch.core.getGroup().id).toBe(bobGroup.id);
      expect(branch.core.getGroup().myRole()).toBe("admin");
      branch.set("key", "bob");

      expect(branch.get("key")).toBe("bob");
    });

    test("an account with write access to the source and read access to the branch should be able to merge a branch created by a reader", async () => {
      const alice = await setupTestAccount({
        connected: true,
      });
      const bob = await setupTestAccount({
        connected: true,
      });
      const group = alice.node.createGroup();
      group.addMember(
        await loadCoValueOrFail(alice.node, bob.accountID),
        "reader",
      );
      const map = group.createMap();
      map.set("key", "alice");

      const bobGroup = bob.node.createGroup();
      bobGroup.addMember(
        await loadCoValueOrFail(bob.node, alice.accountID),
        "reader",
      );

      const mapOnBob = await loadCoValueOrFail(bob.node, map.id);

      const branch = expectMap(
        mapOnBob.core
          .createBranch("feature-branch", bobGroup.id)
          .getCurrentContent(),
      );

      branch.set("key", "bob");

      expect(branch.get("key")).toBe("bob");

      const branchOnAlice = await loadCoValueOrFail(alice.node, branch.id);
      branchOnAlice.core.mergeBranch();

      expect(map.get("key")).toBe("bob");
    });

    test("should not allow the creation of public branches to accounts with read access", async () => {
      const alice = setupTestNode({
        connected: true,
      });
      const bob = await setupTestAccount({
        connected: true,
      });
      const group = alice.node.createGroup();
      group.addMember(
        await loadCoValueOrFail(alice.node, bob.accountID),
        "reader",
      );
      const map = group.createMap();
      map.set("key", "alice");

      const mapOnBob = await loadCoValueOrFail(bob.node, map.id);

      const branch = expectMap(
        mapOnBob.core.createBranch("feature-branch").getCurrentContent(),
      );

      expect(mapOnBob.core.branches).toEqual([]);

      expect(branch.id).toBe(map.id);
    });
  });

  describe("Branch Loading and Checkout", () => {
    test("should create new branch when checking out non-existent branch", async () => {
      const client = setupTestNode({
        connected: true,
      });
      const group = jazzCloud.node.createGroup();
      group.addMember("everyone", "writer");

      const originalMap = group.createMap();
      const branchName = "feature-branch";

      // Add initial data to original map
      originalMap.set("key1", "value1");
      originalMap.set("key2", "value2");

      // Checkout non-existent branch - should create new one
      const branch = await client.node.checkoutBranch(
        originalMap.id,
        branchName,
      );

      expect(branch).not.toBe("unavailable");

      if (branch !== "unavailable") {
        // Verify branch inherits original data
        expect(branch.get("key1")).toBe("value1");
        expect(branch.get("key2")).toBe("value2");

        // Add new data to branch
        branch.set("branchKey", "branchValue");

        await branch.core.waitForSync();

        // Verify original map doesn't have branch data
        expect(originalMap.get("branchKey")).toBe(undefined);
        expect(branch.get("branchKey")).toBe("branchValue");
      }
    });

    test("should load existing branch when checking out created branch", async () => {
      const client = setupTestNode({
        connected: true,
      });
      const group = jazzCloud.node.createGroup();
      group.addMember("everyone", "writer");

      const originalMap = group.createMap();
      const branchName = "feature-branch";

      // Add initial data to original map
      originalMap.set("key1", "value1");
      originalMap.set("key2", "value2");

      // Create branch with some data
      const originalBranch = expectMap(
        originalMap.core.createBranch(branchName, group.id).getCurrentContent(),
      );

      originalBranch.set("branchKey", "branchValue");

      // Checkout existing branch - should return created branch
      const branch = await client.node.checkoutBranch(
        originalMap.id,
        branchName,
      );

      expect(branch).not.toBe("unavailable");

      if (branch !== "unavailable") {
        // Verify branch contains both original and new data
        expect(branch.get("key1")).toBe("value1");
        expect(branch.get("key2")).toBe("value2");
        expect(branch.get("branchKey")).toBe("branchValue");
      }
    });

    test("should successfully load existing branch via node.load", async () => {
      const client = setupTestNode({
        connected: true,
      });
      const group = jazzCloud.node.createGroup();
      group.addMember("everyone", "writer");

      const originalMap = group.createMap();
      const branchName = "feature-branch";

      // Add initial data to original map
      originalMap.set("key1", "value1");
      originalMap.set("key2", "value2");

      // Create branch with some data
      const originalBranch = expectMap(
        originalMap.core.createBranch(branchName, group.id).getCurrentContent(),
      );

      originalBranch.set("branchKey", "branchValue");

      // Load existing branch via node.load
      const branch = await client.node.load(originalBranch.id);

      expect(branch).not.toBe("unavailable");

      if (branch !== "unavailable") {
        // Verify branch contains all expected data
        expect(branch.get("key1")).toBe("value1");
        expect(branch.get("key2")).toBe("value2");
        expect(branch.get("branchKey")).toBe("branchValue");
      }
    });

    test("should create branch with different group owner when specified", async () => {
      const client = setupTestNode({
        connected: true,
      });
      const group = jazzCloud.node.createGroup();
      group.addMember("everyone", "writer");

      const originalMap = group.createMap();
      const branchName = "feature-branch";

      // Add initial data to original map
      originalMap.set("key1", "value1");
      originalMap.set("key2", "value2");

      // Create different group to own the branch
      const branchGroup = client.node.createGroup();

      // Checkout branch with different group as owner
      const branch = await client.node.checkoutBranch(
        originalMap.id,
        branchName,
        branchGroup.id,
      );

      expect(branch).not.toBe("unavailable");

      if (branch !== "unavailable") {
        // Verify branch inherits original data
        expect(branch.get("key1")).toBe("value1");
        expect(branch.get("key2")).toBe("value2");

        // Add new data to branch
        branch.set("branchKey", "branchValue");

        await branch.core.waitForSync();

        // Verify original map doesn't have branch data
        expect(originalMap.get("branchKey")).toBe(undefined);
        expect(branch.get("branchKey")).toBe("branchValue");
      }

      // Verify that the sync server can't read the branch content
      const branchOnTheServer = await jazzCloud.node.checkoutBranch(
        originalMap.id,
        branchName,
        branchGroup.id,
      );

      expect(branchOnTheServer).not.toBe("unavailable");

      if (branchOnTheServer !== "unavailable") {
        expect(branchOnTheServer.get("branchKey")).toBe(undefined);
        expect(branchOnTheServer.get("key1")).toBe(undefined);
        expect(branchOnTheServer.get("key2")).toBe(undefined);
      }
    });

    test("should return the source value when trying to checkout branch from group", async () => {
      const client = setupTestNode({
        connected: true,
      });
      const group = jazzCloud.node.createGroup();
      group.addMember("everyone", "writer");

      // Try to checkout branch from group (groups don't support branching)
      const branch = await client.node.checkoutBranch(
        group.id,
        "feature-branch",
      );

      expect(branch).not.toBe("unavailable");

      if (branch !== "unavailable") {
        expect(branch.id).toBe(group.id);
      }
    });

    test("should return unavailable when source value is unreachable", async () => {
      // Create client without sync server connection
      const client = setupTestNode();

      const group = jazzCloud.node.createGroup();
      group.addMember("everyone", "writer");

      // Create map on sync server (unreachable from client)
      const originalMap = group.createMap();
      originalMap.set("key1", "value1");

      // Try to checkout branch on unreachable map
      const branch = await client.node.checkoutBranch(
        originalMap.id,
        "feature-branch",
      );

      // Should return unavailable since checkout failed
      expect(branch).toBe("unavailable");
    });
  });

  describe("Branch Conflict Resolution", () => {
    test("should successfully handle concurrent branch creation on different nodes", async () => {
      const alice = setupTestNode({
        connected: true,
      });

      const bob = setupTestNode();
      let { peerState: bobPeer } = bob.connectToSyncServer();

      const group = jazzCloud.node.createGroup();
      group.addMember("everyone", "writer");

      // Create map without any branches
      const map = group.createMap();

      const bobMap = await loadCoValueOrFail(bob.node, map.id);

      // Disconnect bob from sync server to create isolation
      bobPeer.gracefulShutdown();

      bobMap.set("bob", "main");
      map.set("alice", "main");

      // Create branches on different nodes
      const aliceBranch = await alice.node.checkoutBranch(
        map.id,
        "feature-branch",
      );
      const bobBranch = await bob.node.checkoutBranch(map.id, "feature-branch");

      if (aliceBranch === "unavailable" || bobBranch === "unavailable") {
        throw new Error("Alice or bob branch is unavailable");
      }

      // The branch start should be different
      expect(aliceBranch.get("alice")).toBe("main");
      expect(aliceBranch.get("bob")).toBe(undefined);
      expect(bobBranch.get("alice")).toBe(undefined);
      expect(bobBranch.get("bob")).toBe("main");

      expect(aliceBranch.core.branchStart).not.toEqual(
        bobBranch.core.branchStart,
      );

      // Reconnect bob to sync server
      bobPeer = bob.connectToSyncServer().peerState;

      await aliceBranch.core.waitForSync();
      await bobBranch.core.waitForSync();

      // The branch start from both branches should be aligned now
      expect(aliceBranch.get("alice")).toBe("main");
      expect(aliceBranch.get("bob")).toBe("main");
      expect(bobBranch.get("alice")).toBe("main");
      expect(bobBranch.get("bob")).toBe("main");

      expect(aliceBranch.core.branchStart).toEqual(bobBranch.core.branchStart);
    });
  });

  describe("hasBranch", () => {
    test("should work when the branch owner is the source owner", () => {
      const client = setupTestNode({
        connected: true,
      });
      const group = client.node.createGroup();
      const map = group.createMap();

      map.set("key", "value");

      const branch = map.core.createBranch("feature-branch", group.id);

      expect(map.core.hasBranch("feature-branch")).toBe(true);
      expect(map.core.hasBranch("feature-branch", group.id)).toBe(true);
      expect(branch.hasBranch("feature-branch")).toBe(false);
    });

    test("should work when the branch onwer is implicit", () => {
      const client = setupTestNode({
        connected: true,
      });
      const group = client.node.createGroup();
      const map = group.createMap();

      map.set("key", "value");

      const branch = map.core.createBranch("feature-branch");

      expect(map.core.hasBranch("feature-branch")).toBe(true);
      expect(map.core.hasBranch("feature-branch", group.id)).toBe(true);
      expect(branch.hasBranch("feature-branch")).toBe(false);
    });

    test("should return false for non-existent branch name", () => {
      const client = setupTestNode({
        connected: true,
      });
      const group = client.node.createGroup();
      const map = group.createMap();

      map.set("key", "value");

      expect(map.core.hasBranch("non-existent-branch")).toBe(false);
    });

    test("should work with explicit ownerId parameter", () => {
      const client = setupTestNode({
        connected: true,
      });
      const group = client.node.createGroup();
      const map = group.createMap();

      map.set("key", "value");

      const differentGroup = client.node.createGroup();

      map.core.createBranch("feature-branch", differentGroup.id);

      // Test with explicit ownerId
      expect(map.core.hasBranch("feature-branch", differentGroup.id)).toBe(
        true,
      );
      expect(map.core.hasBranch("feature-branch")).toBe(false);
    });

    test("should work when the transactions have not been parsed yet", async () => {
      const client = setupTestNode({
        connected: true,
      });
      const group = client.node.createGroup();
      const map = group.createMap();

      map.set("key", "value");

      map.core.createBranch("feature-branch", group.id);

      await map.core.waitForSync();

      const newSession = client.spawnNewSession();
      const loadedMapCore = await newSession.node.loadCoValueCore(map.core.id);

      expect(loadedMapCore.hasBranch("feature-branch", group.id)).toBe(true);
    });
  });
});
