import { beforeEach, expect, test, vi } from "vitest";
import { expectList } from "../coValue.js";
import { WasmCrypto } from "../crypto/WasmCrypto.js";
import { importContentIntoNode, setupTestNode } from "./testUtils.js";

const Crypto = await WasmCrypto.create();

beforeEach(() => {
  setupTestNode({ isSyncServer: true });
});

/**
 * Creates a group + private CoList on `client`, then imports the raw content
 * (undecrypted) into a fresh session of the same account so that decryption is
 * deferred until we first read the loaded CoValueCore. Returns that fresh,
 * not-yet-decrypted CoValueCore plus the expected plaintext.
 */
function importUndecryptedListInFreshSession(items: string[]) {
  const client = setupTestNode();
  const group = client.node.createGroup();
  const list = group.createList();
  for (const item of items) {
    list.append(item, undefined, "private");
  }

  // The creating session decrypts fine (sanity check on the fast path).
  const originalTxs = list.core.getValidSortedTransactions();
  expect(originalTxs).toHaveLength(items.length);
  expect(expectList(list.core.getCurrentContent()).toJSON()).toEqual(items);

  // Fresh session on the same account: import raw content without building the
  // content view, so no decryption has happened yet.
  const newSession = client.spawnNewSession();
  importContentIntoNode(group.core, newSession.node);
  importContentIntoNode(list.core, newSession.node);

  const listCore = newSession.node.expectCoValueLoaded(list.id);
  return { listCore, items };
}

test("CoList with private transactions loads when decryptTransactions is absent (fallback)", () => {
  const { listCore, items } = importUndecryptedListInFreshSession([
    "a",
    "b",
    "c",
  ]);

  // Simulate a native impl without batch support.
  (
    listCore.verified as unknown as { impl: Record<string, unknown> }
  ).impl.decryptTransactions = undefined;

  const txs = listCore.getValidSortedTransactions();
  expect(txs).toHaveLength(items.length);
  expect(expectList(listCore.getCurrentContent()).toJSON()).toEqual(items);
});

test("CoList with private transactions loads when decryptTransactions returns garbage (per-tx fallback)", () => {
  const { listCore, items } = importUndecryptedListInFreshSession([
    "x",
    "y",
    "z",
  ]);

  // Batch method present, but returns non-JSON: the combined parse must fail
  // and the per-transaction fallback must produce the correct entries.
  const garbage = vi.fn(() => "not json");
  (
    listCore.verified as unknown as {
      impl: Record<string, unknown>;
    }
  ).impl.decryptTransactions = garbage;

  const txs = listCore.getValidSortedTransactions();

  expect(garbage).toHaveBeenCalled();
  expect(txs).toHaveLength(items.length);
  expect(expectList(listCore.getCurrentContent()).toJSON()).toEqual(items);
});
