import { describe, expect, test } from "vitest";
import {
  transactionsEqual,
  findCommonPrefixLength,
} from "../recovery/utils.js";
import { normalizeAuthoritativeSessionContent } from "../recovery/normalizeAuthoritativeSessionContent.js";
import type { Transaction } from "../coValueCore/verifiedState.js";
import type { Signature } from "../crypto/crypto.js";

const sig = "test-signature" as Signature;

function trustingTx(changes: string, madeAt = 1000): Transaction {
  return { privacy: "trusting", madeAt, changes } as unknown as Transaction;
}

describe("transactionsEqual", () => {
  test("equal trusting transactions", () => {
    const a = trustingTx('["set","a"]');
    const b = trustingTx('["set","a"]');
    expect(transactionsEqual(a, b)).toBe(true);
  });

  test("different changes", () => {
    const a = trustingTx('["set","a"]');
    const b = trustingTx('["set","b"]');
    expect(transactionsEqual(a, b)).toBe(false);
  });

  test("different madeAt", () => {
    const a = trustingTx('["set","a"]', 1000);
    const b = trustingTx('["set","a"]', 2000);
    expect(transactionsEqual(a, b)).toBe(false);
  });
});

describe("findCommonPrefixLength", () => {
  test("full overlap", () => {
    const txs = [trustingTx("a"), trustingTx("b")];
    expect(findCommonPrefixLength(txs, [...txs])).toBe(2);
  });

  test("partial overlap", () => {
    const local = [trustingTx("a"), trustingTx("b")];
    const auth = [trustingTx("a"), trustingTx("c")];
    expect(findCommonPrefixLength(local, auth)).toBe(1);
  });

  test("no overlap", () => {
    const local = [trustingTx("a")];
    const auth = [trustingTx("b")];
    expect(findCommonPrefixLength(local, auth)).toBe(0);
  });
});

describe("normalizeAuthoritativeSessionContent", () => {
  test("normalizes valid single chunk", () => {
    const result = normalizeAuthoritativeSessionContent([
      { after: 0, newTransactions: [trustingTx("a")], lastSignature: sig },
    ]);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.transactions).toHaveLength(1);
      expect(result.value.lastSignature).toBe(sig);
    }
  });

  test("rejects empty content", () => {
    const result = normalizeAuthoritativeSessionContent([]);
    expect(result.ok).toBe(false);
  });

  test("rejects discontinuous chunks", () => {
    const result = normalizeAuthoritativeSessionContent([
      { after: 0, newTransactions: [trustingTx("a")], lastSignature: sig },
      { after: 5, newTransactions: [trustingTx("b")], lastSignature: sig },
    ]);
    expect(result.ok).toBe(false);
  });

  test("sorts and normalizes multiple chunks", () => {
    const sig2 = "sig2" as Signature;
    const result = normalizeAuthoritativeSessionContent([
      { after: 1, newTransactions: [trustingTx("b")], lastSignature: sig2 },
      { after: 0, newTransactions: [trustingTx("a")], lastSignature: sig },
    ]);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.transactions).toHaveLength(2);
      expect(result.value.lastSignature).toBe(sig2);
    }
  });
});
