import type {
  CoValueHeader,
  Transaction,
} from "../../coValueCore/verifiedState.js";
import type { Signature } from "../../crypto/crypto.js";
import type { RawCoID, SessionID } from "../../exports.js";
import type { CoValueKnownState } from "../../knownState.js";
import { logger } from "../../logger.js";
import type {
  DBClientInterfaceAsync,
  DBTransactionInterfaceAsync,
  SessionRow,
  SignatureAfterRow,
  StorageReconciliationLockRow,
  StoredCoValueRow,
  StoredSessionRow,
  TransactionRow,
  StorageReconciliationAcquireResult,
} from "../types.js";
import { DeletedCoValueDeletionStatus } from "../types.js";
import type { SQLiteDatabaseDriverAsync } from "./types.js";
import type { PeerID } from "../../sync.js";
import { STORAGE_RECONCILIATION_CONFIG } from "../../config.js";

export type RawCoValueRow = {
  id: RawCoID;
  header: string;
};

export type RawTransactionRow = {
  ses: number;
  idx: number;
  tx: string;
};

type DeletedCoValueQueueRow = {
  id: RawCoID;
};

export function getErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : "Unknown error";
}

/**
 * Executes storage operations inside a single DB transaction.
 */
export class SQLiteTransactionAsync implements DBTransactionInterfaceAsync {
  constructor(private readonly tx: SQLiteDatabaseDriverAsync) {}

  async getSingleCoValueSession(
    coValueRowId: number,
    sessionID: SessionID,
  ): Promise<StoredSessionRow | undefined> {
    return this.tx.get<StoredSessionRow>(
      "SELECT * FROM sessions WHERE coValue = ? AND sessionID = ?",
      [coValueRowId, sessionID],
    );
  }

  async markCoValueAsDeleted(id: RawCoID): Promise<void> {
    await this.tx.run(
      `INSERT INTO deletedCoValues (coValueID) VALUES (?) ON CONFLICT(coValueID) DO NOTHING`,
      [id],
    );
  }

  async addSessionUpdate({
    sessionUpdate,
  }: {
    sessionUpdate: SessionRow;
    sessionRow?: StoredSessionRow;
  }): Promise<number> {
    const result = await this.tx.get<{ rowID: number }>(
      `INSERT INTO sessions (coValue, sessionID, lastIdx, lastSignature, bytesSinceLastSignature) VALUES (?, ?, ?, ?, ?)
                            ON CONFLICT(coValue, sessionID) DO UPDATE SET lastIdx=excluded.lastIdx, lastSignature=excluded.lastSignature, bytesSinceLastSignature=excluded.bytesSinceLastSignature
                            RETURNING rowID`,
      [
        sessionUpdate.coValue,
        sessionUpdate.sessionID,
        sessionUpdate.lastIdx,
        sessionUpdate.lastSignature,
        sessionUpdate.bytesSinceLastSignature,
      ],
    );

    if (!result) {
      throw new Error("Failed to add session update");
    }

    return result.rowID;
  }

  async addTransaction(
    sessionRowID: number,
    nextIdx: number,
    newTransaction: Transaction,
  ): Promise<void> {
    // An interrupted write transaction (e.g. a concurrent ROLLBACK on a shared
    // connection) can leave orphan rows at idx >= the session's lastIdx, which
    // would otherwise block the session on this primary key forever.
    // Overwriting is safe: writes always start at the committed lastIdx (see
    // putNewTxs), so a conflicting row is never covered by any stored
    // signature, and the verified replacement commits atomically with the
    // session row and signature that cover it.
    await this.tx.run(
      `INSERT INTO transactions (ses, idx, tx) VALUES (?, ?, ?)
       ON CONFLICT(ses, idx) DO UPDATE SET tx=excluded.tx`,
      [sessionRowID, nextIdx, JSON.stringify(newTransaction)],
    );
  }

  async addSignatureAfter({
    sessionRowID,
    idx,
    signature,
  }: {
    sessionRowID: number;
    idx: number;
    signature: Signature;
  }): Promise<void> {
    // Same recovery rationale as addTransaction: a conflict can only be an
    // orphan row left by an interrupted write transaction, and the verified
    // replacement commits atomically with the matching session update.
    // Orphan signature rows are worse than orphan transactions: loadCoValue
    // reads all signatureAfter rows unbounded by lastIdx, so an orphan here
    // is served to readers until it is overwritten.
    await this.tx.run(
      `INSERT INTO signatureAfter (ses, idx, signature) VALUES (?, ?, ?)
       ON CONFLICT(ses, idx) DO UPDATE SET signature=excluded.signature`,
      [sessionRowID, idx, signature],
    );
  }

  async deleteCoValueContent(
    coValueRow: Pick<StoredCoValueRow, "rowID" | "id">,
  ): Promise<void> {
    await this.tx.run(
      `DELETE FROM transactions
       WHERE ses IN (
         SELECT rowID FROM sessions
         WHERE coValue = ?
           AND sessionID NOT LIKE '%$'
       )`,
      [coValueRow.rowID],
    );

    await this.tx.run(
      `DELETE FROM signatureAfter
       WHERE ses IN (
         SELECT rowID FROM sessions
         WHERE coValue = ?
           AND sessionID NOT LIKE '%$'
       )`,
      [coValueRow.rowID],
    );

    await this.tx.run(
      `DELETE FROM sessions
       WHERE coValue = ?
         AND sessionID NOT LIKE '%$'`,
      [coValueRow.rowID],
    );

    await this.tx.run(
      `INSERT INTO deletedCoValues (coValueID, status) VALUES (?, ?)
       ON CONFLICT(coValueID) DO UPDATE SET status=?`,
      [
        coValueRow.id,
        DeletedCoValueDeletionStatus.Done,
        DeletedCoValueDeletionStatus.Done,
      ],
    );
  }

  async getStorageReconciliationLock(
    key: string,
  ): Promise<StorageReconciliationLockRow | undefined> {
    return this.tx.get<StorageReconciliationLockRow>(
      "SELECT * FROM storageReconciliationLocks WHERE key = ?",
      [key],
    );
  }

  async putStorageReconciliationLock(
    entry: StorageReconciliationLockRow,
  ): Promise<void> {
    const {
      key,
      holderSessionId,
      acquiredAt,
      releasedAt,
      lastProcessedOffset,
    } = entry;
    await this.tx.run(
      `INSERT OR REPLACE INTO storageReconciliationLocks (key, holderSessionId, acquiredAt, releasedAt, lastProcessedOffset) VALUES (?, ?, ?, ?, ?)`,
      [
        key,
        holderSessionId,
        acquiredAt,
        releasedAt ?? null,
        lastProcessedOffset,
      ],
    );
  }
}

export class SQLiteClientAsync implements DBClientInterfaceAsync {
  private readonly db: SQLiteDatabaseDriverAsync;
  /** Serialize transactions to avoid SQLITE_BUSY errors */
  private txQueue = Promise.resolve() as Promise<unknown>;

  constructor(db: SQLiteDatabaseDriverAsync) {
    this.db = db;
  }

  private enqueueTx<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.txQueue.then(fn, fn);
    this.txQueue = next;
    return next;
  }

  async getCoValue(coValueId: RawCoID): Promise<StoredCoValueRow | undefined> {
    const coValueRow = await this.db.get<RawCoValueRow & { rowID: number }>(
      "SELECT * FROM coValues WHERE id = ?",
      [coValueId],
    );

    if (!coValueRow) return;

    try {
      const parsedHeader = (coValueRow?.header &&
        JSON.parse(coValueRow.header)) as CoValueHeader;

      return {
        ...coValueRow,
        header: parsedHeader,
      };
    } catch (e) {
      const headerValue = coValueRow?.header ?? "";
      logger.warn(`Invalid JSON in header: ${headerValue}`, {
        id: coValueId,
        err: e,
      });
      return;
    }
  }

  async getCoValueSessions(coValueRowId: number): Promise<StoredSessionRow[]> {
    return this.db.query<StoredSessionRow>(
      "SELECT * FROM sessions WHERE coValue = ?",
      [coValueRowId],
    );
  }

  async getNewTransactionInSession(
    sessionRowId: number,
    fromIdx: number,
    toIdx: number,
  ): Promise<TransactionRow[]> {
    const txs = await this.db.query<RawTransactionRow>(
      "SELECT * FROM transactions WHERE ses = ? AND idx >= ? AND idx <= ?",
      [sessionRowId, fromIdx, toIdx],
    );

    try {
      return txs.map((transactionRow) => ({
        ...transactionRow,
        tx: JSON.parse(transactionRow.tx) as Transaction,
      }));
    } catch (e) {
      logger.warn("Invalid JSON in transaction", { err: e });
      return [];
    }
  }

  async getSignatures(
    sessionRowId: number,
    firstNewTxIdx: number,
  ): Promise<SignatureAfterRow[]> {
    return this.db.query<SignatureAfterRow>(
      "SELECT * FROM signatureAfter WHERE ses = ? AND idx >= ?",
      [sessionRowId, firstNewTxIdx],
    );
  }

  async getCoValueRowID(id: RawCoID): Promise<number | undefined> {
    const row = await this.db.get<{ rowID: number }>(
      "SELECT rowID FROM coValues WHERE id = ?",
      [id],
    );
    return row?.rowID;
  }

  async upsertCoValue(
    id: RawCoID,
    header?: CoValueHeader,
  ): Promise<number | undefined> {
    if (!header) {
      return this.getCoValueRowID(id);
    }

    const result = await this.db.get<{ rowID: number }>(
      `INSERT INTO coValues (id, header) VALUES (?, ?) 
       ON CONFLICT(id) DO NOTHING 
       RETURNING rowID`,
      [id, JSON.stringify(header)],
    );

    if (!result) {
      return this.getCoValueRowID(id);
    }

    return result.rowID;
  }

  async eraseCoValueButKeepTombstone(coValueId: RawCoID) {
    const coValueRow = await this.db.get<RawCoValueRow & { rowID: number }>(
      "SELECT * FROM coValues WHERE id = ?",
      [coValueId],
    );

    if (!coValueRow) {
      logger.warn(`CoValue ${coValueId} not found, skipping deletion`);
      return;
    }

    await this.transaction(async (tx) => {
      await tx.deleteCoValueContent(coValueRow);
    });
  }

  async getAllCoValuesWaitingForDelete(): Promise<RawCoID[]> {
    const rows = await this.db.query<DeletedCoValueQueueRow>(
      `SELECT coValueID as id
         FROM deletedCoValues
         WHERE status = ?`,
      [DeletedCoValueDeletionStatus.Pending],
    );
    return rows.map((r) => r.id);
  }

  async deleteSessionContent(
    coValueRowId: number,
    sessionID: SessionID,
  ): Promise<void> {
    await this.enqueueTx(async () => {
      const sessionRow = await this.db.get<{ rowID: number }>(
        "SELECT rowID FROM sessions WHERE coValue = ? AND sessionID = ?",
        [coValueRowId, sessionID],
      );

      if (!sessionRow) return;

      await this.db.run("DELETE FROM transactions WHERE ses = ?", [
        sessionRow.rowID,
      ]);
      await this.db.run("DELETE FROM signatureAfter WHERE ses = ?", [
        sessionRow.rowID,
      ]);
      await this.db.run("DELETE FROM sessions WHERE rowID = ?", [
        sessionRow.rowID,
      ]);
    });
  }

  async transaction(
    operationsCallback: (tx: DBTransactionInterfaceAsync) => Promise<unknown>,
  ): Promise<unknown> {
    return this.enqueueTx(() =>
      this.db.transaction((tx) =>
        operationsCallback(new SQLiteTransactionAsync(tx)),
      ),
    );
  }

  async getUnsyncedCoValueIDs(): Promise<RawCoID[]> {
    const rows = await this.db.query<{ co_value_id: RawCoID }>(
      "SELECT DISTINCT co_value_id FROM unsynced_covalues",
      [],
    );
    return rows.map((row) => row.co_value_id);
  }

  async trackCoValuesSyncState(
    updates: { id: RawCoID; peerId: PeerID; synced: boolean }[],
  ): Promise<void> {
    await Promise.all(
      updates.map(async (update) => {
        if (update.synced) {
          await this.db.run(
            "DELETE FROM unsynced_covalues WHERE co_value_id = ? AND peer_id = ?",
            [update.id, update.peerId],
          );
        } else {
          await this.db.run(
            "INSERT OR REPLACE INTO unsynced_covalues (co_value_id, peer_id) VALUES (?, ?)",
            [update.id, update.peerId],
          );
        }
      }),
    );
  }

  async stopTrackingSyncState(id: RawCoID): Promise<void> {
    await this.db.run("DELETE FROM unsynced_covalues WHERE co_value_id = ?", [
      id,
    ]);
  }

  async getCoValueIDs(
    limit: number,
    offset: number,
  ): Promise<{ id: RawCoID }[]> {
    return this.db.query<{ id: RawCoID }>(
      "SELECT id FROM coValues WHERE rowID > ? ORDER BY rowID LIMIT ?",
      [offset, limit],
    );
  }

  async getCoValueCount(): Promise<number> {
    const row = await this.db.get<{ count: number }>(
      "SELECT COUNT(*) as count FROM coValues",
      [],
    );
    return row?.count ?? 0;
  }

  async tryAcquireStorageReconciliationLock(
    sessionId: SessionID,
    peerId: PeerID,
  ): Promise<StorageReconciliationAcquireResult> {
    let result: StorageReconciliationAcquireResult = {
      acquired: false,
      reason: "not_due",
    };
    await this.transaction(async (tx) => {
      const now = Date.now();
      const lockKey = `lock#${peerId}`;

      const lockRow = await tx.getStorageReconciliationLock(lockKey);
      if (
        lockRow?.releasedAt &&
        now - lockRow.releasedAt <
          STORAGE_RECONCILIATION_CONFIG.RECONCILIATION_INTERVAL_MS
      ) {
        result = { acquired: false, reason: "not_due" };
        return;
      }
      const expiresAt = lockRow
        ? lockRow.acquiredAt + STORAGE_RECONCILIATION_CONFIG.LOCK_TTL_MS
        : 0;
      const isLockHeldByOtherSession = lockRow?.holderSessionId !== sessionId;
      if (
        lockRow &&
        !lockRow.releasedAt &&
        expiresAt >= now &&
        isLockHeldByOtherSession
      ) {
        result = { acquired: false, reason: "lock_held" };
        return;
      }

      const lastProcessedOffset =
        lockRow && !lockRow.releasedAt ? (lockRow.lastProcessedOffset ?? 0) : 0;
      await tx.putStorageReconciliationLock({
        key: lockKey,
        holderSessionId: sessionId,
        acquiredAt: now,
        lastProcessedOffset,
      });
      result = { acquired: true, lastProcessedOffset };
    });
    return result;
  }

  async renewStorageReconciliationLock(
    sessionId: SessionID,
    peerId: PeerID,
    offset: number,
  ): Promise<void> {
    await this.transaction(async (tx) => {
      const lockKey = `lock#${peerId}`;
      const lockRow = await tx.getStorageReconciliationLock(lockKey);
      if (
        lockRow &&
        lockRow.holderSessionId === sessionId &&
        !lockRow.releasedAt
      ) {
        await tx.putStorageReconciliationLock({
          ...lockRow,
          lastProcessedOffset: offset,
        });
      }
    });
  }

  async releaseStorageReconciliationLock(
    sessionId: SessionID,
    peerId: PeerID,
  ): Promise<void> {
    await this.transaction(async (tx) => {
      const lockKey = `lock#${peerId}`;
      const releasedAt = Date.now();
      const lockRow = await tx.getStorageReconciliationLock(lockKey);
      if (lockRow && lockRow.holderSessionId === sessionId) {
        await tx.putStorageReconciliationLock({
          ...lockRow,
          releasedAt,
          lastProcessedOffset: 0,
        });
      }
    });
  }

  async getCoValueKnownState(
    coValueId: string,
  ): Promise<CoValueKnownState | undefined> {
    // First check if the CoValue exists
    const coValueRow = await this.db.get<{ rowID: number }>(
      "SELECT rowID FROM coValues WHERE id = ?",
      [coValueId],
    );

    if (!coValueRow) {
      return undefined;
    }

    // Get all session counters without loading transactions
    const sessions = await this.db.query<{
      sessionID: SessionID;
      lastIdx: number;
    }>("SELECT sessionID, lastIdx FROM sessions WHERE coValue = ?", [
      coValueRow.rowID,
    ]);

    const knownState: CoValueKnownState = {
      id: coValueId as RawCoID,
      header: true,
      sessions: {},
    };

    for (const session of sessions) {
      knownState.sessions[session.sessionID] = session.lastIdx;
    }

    return knownState;
  }
}
