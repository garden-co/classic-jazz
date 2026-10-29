/**
 * Regression test for the native group-verdict application scope.
 *
 * `determineValidTransactionsNative` mirrors the TS group-permission fallback,
 * which re-marks the FULL `verifiedTransactions` history on every pass. That
 * apply-all is the only carrier of a permission FLIP to an already-processed
 * group transaction (groups never get `resetParsedTransactions`). If the native
 * path scopes verdict application to the per-pass delta
 * (`toValidateTransactions`) for the group ruleset, a late out-of-order
 * revocation cannot flip an earlier, already-validated group transaction to
 * invalid — native would keep granting access the TS engine denies.
 *
 * Scenario (t1 < t2 < t3):
 *   t1: A (creator/admin) adds B as manager.
 *   t3: B (then a manager) adds C as writer — INGESTED AND VALIDATED FIRST.
 *   t2: A revokes B — authored in a SEPARATE session (clone → fresh sessionID)
 *       so it can be DELIVERED AFTER the t3 write was already validated.
 *
 * (B is a manager rather than an admin because an admin cannot demote/revoke
 * another admin, but can revoke a manager — while a manager can still add a
 * writer, giving us a valid revocation of a valid earlier grant.)
 *
 * After the late revocation arrives, B was not a manager at t3, so B's "add C"
 * must flip to invalid. This test asserts that on the native path (NapiCrypto).
 */
import { expect, test, vi } from "vitest";
import { ControlledAccount, ControlledAgent } from "../coValues/account.js";
import { type RawGroup } from "../coValues/group.js";
import { NapiCrypto } from "../crypto/NapiCrypto.js";
import { LocalNode } from "../localNode.js";
import { expectGroup } from "../typeUtils/expectGroup.js";

const Crypto = await NapiCrypto.create();

function newNodeWithGroup() {
  const agentSecret = Crypto.newRandomAgentSecret();
  const sessionID = Crypto.newRandomSessionID(Crypto.getAgentID(agentSecret));
  const node = new LocalNode(agentSecret, sessionID, Crypto);
  const group = node.createGroup();
  // The bare agent that created the group is the initial admin.
  const admin = new ControlledAgent(agentSecret, Crypto);
  return { node, group, admin };
}

function createAccountInNode(node: LocalNode) {
  const account = LocalNode.internalCreateAccount({ crypto: node.crypto });
  const entry = node.getCoValue(account.id);
  const content = account.core.newContentSince(undefined)?.[0]!;
  node.syncManager.handleNewContent(content, "import");
  return new ControlledAccount(
    entry.getCurrentContent() as any,
    account.core.node.agentSecret,
  );
}

/**
 * Runs `fn` against the group content as authored by `account` (in a cloned
 * node, which mints a FRESH session for `account`), then returns the resulting
 * content chunks WITHOUT importing them — so the caller controls delivery
 * order. Mirrors the `actAs` idiom from groupEngineDifferential.test.ts.
 */
async function authorAs(
  node: LocalNode,
  coId: RawGroup["id"],
  account: ControlledAccount | ControlledAgent,
  fn: (group: RawGroup) => void,
) {
  const core = node.getCoValue(coId);
  const content = await core.contentInClonedNodeWithDifferentAccount(account);
  fn(expectGroup(content));
  return content.core.newContentSince(undefined) ?? [];
}

test("native: a late out-of-order group revocation flips an already-validated downstream transaction to invalid", async () => {
  vi.useFakeTimers();
  try {
    const setTime = (ms: number) => vi.setSystemTime(ms);

    const t0 = 1_700_000_000_000;
    const t1 = 1_700_000_001_000;
    const t2 = 1_700_000_002_000;
    const t3 = 1_700_000_003_000;

    // Anchor the clock BEFORE creating the group so the creation transaction's
    // madeAt (t0) precedes every op below (t1 < t2 < t3). `vi.useFakeTimers()`
    // otherwise seeds the clock to the real current time, which would land
    // AFTER these fixed timestamps.
    setTime(t0);
    const { node, group, admin } = newNodeWithGroup();
    const B = createAccountInNode(node);
    const C = createAccountInNode(node);

    // t1: A adds B as manager (authored locally in A's session on `node`).
    setTime(t1);
    (group.set as any)(B.id, "manager", "trusting");
    expect(group.get(B.id)).toBe("manager");

    // t3: B (currently a manager) adds C as writer. Ingested & validated NOW,
    // before the revocation exists on `node`.
    setTime(t3);
    const addCChunks = await authorAs(node, group.id, B, (g) => {
      (g.set as any)(C.id, "writer", "trusting");
    });
    for (const chunk of addCChunks) {
      node.syncManager.handleNewContent(chunk, "import");
    }

    // Sanity: on the native path, B's "add C" validated true and C is a writer.
    group.core.getValidTransactions({ ignorePrivateTransactions: false });
    const addCBefore = group.core.verifiedTransactions.find(
      (tx) => tx.author === B.id,
    );
    expect(addCBefore, "B's add-C transaction should be present").toBeDefined();
    expect(addCBefore!.isValid).toBe(true);
    expect(expectGroup(group.core.getCurrentContent()).get(C.id)).toBe(
      "writer",
    );

    // t2 (< t3): A revokes B. Authored in a cloned node, so this lands in a
    // SEPARATE session from A's original (create + add-B) session — letting it
    // be DELIVERED after the t3 write was already ingested and validated.
    setTime(t2);
    const revokeChunks = await authorAs(node, group.id, admin, (g) => {
      (g.set as any)(B.id, "revoked", "trusting");
    });
    for (const chunk of revokeChunks) {
      node.syncManager.handleNewContent(chunk, "import");
    }

    // After the late revocation: B was NOT an admin at t3, so B's "add C" must
    // now be invalid. On d9cc91a77's delta-only native path this stays valid
    // (the bug); the per-ruleset apply-all fix flips it.
    group.core.getValidTransactions({ ignorePrivateTransactions: false });
    const addCAfter = group.core.verifiedTransactions.find(
      (tx) => tx.author === B.id,
    );
    expect(addCAfter, "B's add-C transaction should be present").toBeDefined();
    expect(addCAfter!.isValid).toBe(false);

    // ...and C's write access is gone. The parsed-content rebuild triggered by
    // the flip is deferred to a microtask, so flush it before reading the
    // member map.
    await Promise.resolve();
    const groupAfter = expectGroup(group.core.getCurrentContent());
    expect(groupAfter.get(C.id)).toBeUndefined();
    expect(groupAfter.roleOfInternal(C.id)).toBeUndefined();
  } finally {
    vi.useRealTimers();
  }
});
