import { AvailableCoValueCore, VerifiedTransaction } from "./coValueCore.js";

export function decryptTransactionChangesAndMeta(
  coValue: AvailableCoValueCore,
  transaction: VerifiedTransaction,
) {
  if (
    !transaction.isValid ||
    transaction.tx.privacy === "trusting" // Trusting transactions are already decrypted
  ) {
    return;
  }

  const needsChagesParsing = !transaction.changes;
  const needsMetaParsing = !transaction.meta && transaction.tx.meta;

  if (!needsChagesParsing && !needsMetaParsing) {
    return;
  }

  const readKey = coValue.getReadKey(transaction.tx.keyUsed);

  if (!readKey) {
    return;
  }

  // R1 (experimental, parallel to the TS decrypt below): feed the resolved
  // secret to the native key store so Rust-resident coMap materialization can
  // decrypt this key's private transactions itself. Key MANAGEMENT stays in TS
  // (this `getReadKey` did the unsealing/revelation-chain work); we only hand
  // the resolved secret across. Idempotent, and cheap once `readKeyCache` is
  // warm. The TS decrypt path below is unchanged — R1 runs both in parallel.
  coValue.node.nodeCore.provideKeySecret(transaction.tx.keyUsed, readKey);

  if (needsChagesParsing) {
    const changes = coValue.verified.decryptTransaction(
      transaction.txID.sessionID,
      transaction.txID.txIndex,
      readKey,
    );

    if (changes) {
      transaction.changes = changes;
    }
  }

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
