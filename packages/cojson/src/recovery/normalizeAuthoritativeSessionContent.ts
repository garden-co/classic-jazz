import type { Signature } from "../crypto/crypto.js";
import type { SessionNewContent } from "../sync.js";
import type { Transaction } from "../coValueCore/verifiedState.js";

export type NormalizedAuthoritativeSession = {
  content: SessionNewContent[];
  transactions: Transaction[];
  lastSignature: Signature;
};

export type NormalizeAuthoritativeSessionContentResult =
  | { ok: true; value: NormalizedAuthoritativeSession }
  | { ok: false; error: AuthoritativeSessionNormalizationError };

export class AuthoritativeSessionNormalizationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AuthoritativeSessionNormalizationError";
  }
}

export function normalizeAuthoritativeSessionContent(
  content: SessionNewContent[],
): NormalizeAuthoritativeSessionContentResult {
  if (content.length === 0) {
    return {
      ok: false,
      error: new AuthoritativeSessionNormalizationError(
        "Authoritative content must include at least one session chunk",
      ),
    };
  }

  const ordered = [...content].sort((a, b) => a.after - b.after);
  const transactions: Transaction[] = [];
  const normalized: SessionNewContent[] = [];
  let expectedAfter = 0;

  for (const [index, chunk] of ordered.entries()) {
    if (chunk.after !== expectedAfter) {
      return {
        ok: false,
        error: new AuthoritativeSessionNormalizationError(
          `Invalid authoritative content continuity at chunk ${index}: expected after=${expectedAfter}, got after=${chunk.after}`,
        ),
      };
    }
    if (chunk.newTransactions.length === 0) {
      return {
        ok: false,
        error: new AuthoritativeSessionNormalizationError(
          `Invalid authoritative content at chunk ${index}: empty newTransactions`,
        ),
      };
    }
    normalized.push({
      after: expectedAfter,
      newTransactions: [...chunk.newTransactions],
      lastSignature: chunk.lastSignature,
    });
    transactions.push(...chunk.newTransactions);
    expectedAfter += chunk.newTransactions.length;
  }

  const lastChunk = normalized[normalized.length - 1]!;
  return {
    ok: true,
    value: {
      content: normalized,
      transactions,
      lastSignature: lastChunk.lastSignature,
    },
  };
}
