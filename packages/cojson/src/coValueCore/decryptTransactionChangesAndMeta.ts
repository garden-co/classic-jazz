import { KeySecret } from "../crypto/crypto.js";
import { SessionID } from "../ids.js";
import { AvailableCoValueCore, VerifiedTransaction } from "./coValueCore.js";

/**
 * Decrypt the changes and meta of the given transactions in place. Changes
 * decryption is grouped by (sessionID, readKey) and dispatched to
 * `decryptTransactionsBatch` with a single call per group (one native FFI
 * call when the batch fast path is available); meta decryption stays
 * per-transaction (meta is rare).
 *
 * Per-transaction semantics: transactions are skipped when invalid, trusting,
 * or already parsed; a missing read key leaves them undecrypted; and a
 * per-transaction decrypt failure leaves `changes` unset.
 */
export function batchDecryptTransactionChangesAndMeta(
  coValue: AvailableCoValueCore,
  transactions: VerifiedTransaction[],
) {
  type Group = {
    sessionID: SessionID;
    keySecret: KeySecret;
    transactions: VerifiedTransaction[];
  };

  // Groups of changes-needing transactions, keyed by (sessionID, readKey id),
  // in first-seen order so the batch preserves the original ordering.
  const groups = new Map<string, Group>();

  for (const transaction of transactions) {
    if (!transaction.isValid || transaction.tx.privacy === "trusting") {
      continue;
    }

    const needsChangesParsing = !transaction.changes;
    const needsMetaParsing = !transaction.meta && transaction.tx.meta;

    if (!needsChangesParsing && !needsMetaParsing) {
      continue;
    }

    const readKey = coValue.getReadKey(transaction.tx.keyUsed);

    if (!readKey) {
      continue;
    }

    if (needsChangesParsing) {
      const sessionID = transaction.txID.sessionID;
      const keyID = transaction.tx.keyUsed;
      const groupKey = `${sessionID}\n${keyID}`;
      let group = groups.get(groupKey);
      if (!group) {
        group = {
          sessionID,
          keySecret: readKey,
          transactions: [],
        };
        groups.set(groupKey, group);
      }
      group.transactions.push(transaction);
    }

    // Meta is rare, so keep it on the per-transaction path.
    if (needsMetaParsing) {
      const meta = coValue.verified.decryptTransactionMeta(
        transaction.txID.sessionID,
        transaction.txID.txIndex,
        readKey,
      );

      if (meta) {
        transaction.meta = meta;
      }
    }
  }

  for (const group of groups.values()) {
    const results = coValue.verified.decryptTransactionsBatch(
      group.sessionID,
      group.transactions.map((t) => t.txID.txIndex),
      group.keySecret,
    );

    for (let i = 0; i < group.transactions.length; i++) {
      const changes = results[i];
      if (changes) {
        group.transactions[i]!.changes = changes;
      }
    }
  }
}
