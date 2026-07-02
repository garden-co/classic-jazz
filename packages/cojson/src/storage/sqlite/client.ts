import type {
  CoValueHeader,
  Transaction,
} from "../../coValueCore/verifiedState.js";
import type { Signature } from "../../crypto/crypto.js";
import type { RawCoID, SessionID } from "../../exports.js";
import type { CoValueKnownState } from "../../knownState.js";
import type { PeerID } from "../../sync.js";
import { logger } from "../../logger.js";
import type {
  DBClientInterfaceSync,
  DBTransactionInterfaceSync,
  SessionRow,
  SignatureAfterRow,
  StorageReconciliationLockRow,
  StoredCoValueRow,
  StoredSessionRow,
  TransactionRow,
  StorageReconciliationAcquireResult,
} from "../types.js";
import { DeletedCoValueDeletionStatus } from "../types.js";
import type { SQLiteDatabaseDriver } from "./types.js";
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

export class SQLiteClient
  implements DBClientInterfaceSync, DBTransactionInterfaceSync
{
  private readonly db: SQLiteDatabaseDriver;

  constructor(db: SQLiteDatabaseDriver) {
    this.db = db;
  }

  getCoValue(coValueId: RawCoID): StoredCoValueRow | undefined {
    const coValueRow = this.db.get<RawCoValueRow & { rowID: number }>(
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

  getCoValueSessions(coValueRowId: number): StoredSessionRow[] {
    return this.db.query<StoredSessionRow>(
      "SELECT * FROM sessions WHERE coValue = ?",
      [coValueRowId],
    ) as StoredSessionRow[];
  }

  getSingleCoValueSession(
    coValueRowId: number,
    sessionID: SessionID,
  ): StoredSessionRow | undefined {
    return this.db.get<StoredSessionRow>(
      "SELECT * FROM sessions WHERE coValue = ? AND sessionID = ?",
      [coValueRowId, sessionID],
    );
  }

  getNewTransactionInSession(
    sessionRowId: number,
    fromIdx: number,
    toIdx: number,
  ): TransactionRow[] {
    const txs = this.db.query<RawTransactionRow>(
      "SELECT * FROM transactions WHERE ses = ? AND idx >= ? AND idx <= ?",
      [sessionRowId, fromIdx, toIdx],
    ) as RawTransactionRow[];

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

  getSignatures(
    sessionRowId: number,
    firstNewTxIdx: number,
  ): SignatureAfterRow[] {
    return this.db.query<SignatureAfterRow>(
      "SELECT * FROM signatureAfter WHERE ses = ? AND idx >= ?",
      [sessionRowId, firstNewTxIdx],
    ) as SignatureAfterRow[];
  }

  getCoValueRowID(id: RawCoID): number | undefined {
    const row = this.db.get<{ rowID: number }>(
      "SELECT rowID FROM coValues WHERE id = ?",
      [id],
    );
    return row?.rowID;
  }

  upsertCoValue(id: RawCoID, header?: CoValueHeader): number | undefined {
    if (!header) {
      return this.getCoValueRowID(id);
    }

    const result = this.db.get<{ rowID: number }>(
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

  markCoValueAsDeleted(id: RawCoID) {
    // Work queue entry. Table only stores the coValueID.
    // Idempotent by design.
    this.db.run(
      `INSERT INTO deletedCoValues (coValueID) VALUES (?) ON CONFLICT(coValueID) DO NOTHING`,
      [id],
    );
  }

  eraseCoValueButKeepTombstone(coValueId: RawCoID) {
    const coValueRow = this.db.get<{ rowID: number }>(
      "SELECT rowID FROM coValues WHERE id = ?",
      [coValueId],
    );

    if (!coValueRow) {
      logger.warn(`CoValue ${coValueId} not found, skipping deletion`);
      return;
    }

    this.transaction(() => {
      this.db.run(
        `DELETE FROM transactions
       WHERE ses IN (
         SELECT rowID FROM sessions
         WHERE coValue = ?
           AND sessionID NOT LIKE '%$'
       )`,
        [coValueRow.rowID],
      );

      this.db.run(
        `DELETE FROM signatureAfter
       WHERE ses IN (
         SELECT rowID FROM sessions
         WHERE coValue = ?
           AND sessionID NOT LIKE '%$'
       )`,
        [coValueRow.rowID],
      );

      this.db.run(
        `DELETE FROM sessions
       WHERE coValue = ?
         AND sessionID NOT LIKE '%$'`,
        [coValueRow.rowID],
      );

      // Mark the delete as done
      this.db.run(
        `INSERT INTO deletedCoValues (coValueID, status) VALUES (?, ?)
       ON CONFLICT(coValueID) DO UPDATE SET status=?`,
        [
          coValueId,
          DeletedCoValueDeletionStatus.Done,
          DeletedCoValueDeletionStatus.Done,
        ],
      );
    });
  }

  deleteSessionContent(coValueRowId: number, sessionID: SessionID): void {
    const sessionRow = this.db.get<{ rowID: number }>(
      "SELECT rowID FROM sessions WHERE coValue = ? AND sessionID = ?",
      [coValueRowId, sessionID],
    );

    if (!sessionRow) {
      return;
    }

    this.transaction(() => {
      this.db.run("DELETE FROM transactions WHERE ses = ?", [sessionRow.rowID]);
      this.db.run("DELETE FROM signatureAfter WHERE ses = ?", [
        sessionRow.rowID,
      ]);
      this.db.run("DELETE FROM sessions WHERE rowID = ?", [sessionRow.rowID]);
    });
  }

  getAllCoValuesWaitingForDelete(): RawCoID[] {
    return this.db
      .query<DeletedCoValueQueueRow>(
        `SELECT coValueID as id
         FROM deletedCoValues
         WHERE status = ?`,
        [DeletedCoValueDeletionStatus.Pending],
      )
      .map((r) => r.id);
  }

  addSessionUpdate({ sessionUpdate }: { sessionUpdate: SessionRow }): number {
    const result = this.db.get<{ rowID: number }>(
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

  addTransaction(
    sessionRowID: number,
    nextIdx: number,
    newTransaction: Transaction,
  ) {
    this.db.run("INSERT INTO transactions (ses, idx, tx) VALUES (?, ?, ?)", [
      sessionRowID,
      nextIdx,
      JSON.stringify(newTransaction),
    ]);
  }

  addSignatureAfter({
    sessionRowID,
    idx,
    signature,
  }: {
    sessionRowID: number;
    idx: number;
    signature: Signature;
  }) {
    this.db.run(
      "INSERT INTO signatureAfter (ses, idx, signature) VALUES (?, ?, ?)",
      [sessionRowID, idx, signature],
    );
  }

  getStorageReconciliationLock(
    key: string,
  ): StorageReconciliationLockRow | undefined {
    return this.db.get<StorageReconciliationLockRow>(
      "SELECT * FROM storageReconciliationLocks WHERE key = ?",
      [key],
    );
  }

  putStorageReconciliationLock(entry: StorageReconciliationLockRow): void {
    const {
      key,
      holderSessionId,
      acquiredAt,
      releasedAt,
      lastProcessedOffset,
    } = entry;
    this.db.run(
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

  transaction(operationsCallback: (tx: DBTransactionInterfaceSync) => unknown) {
    this.db.transaction(() => operationsCallback(this));
    return undefined;
  }

  getCoValueIDs(limit: number, offset: number): { id: RawCoID }[] {
    return this.db.query<{ id: RawCoID }>(
      "SELECT id FROM coValues WHERE rowID > ? ORDER BY rowID LIMIT ?",
      [offset, limit],
    );
  }

  getCoValueCount(): number {
    const row = this.db.get<{ count: number }>(
      "SELECT COUNT(*) as count FROM coValues",
      [],
    );
    return row?.count ?? 0;
  }

  getUnsyncedCoValueIDs(): RawCoID[] {
    const rows = this.db.query<{ co_value_id: RawCoID }>(
      "SELECT DISTINCT co_value_id FROM unsynced_covalues",
      [],
    ) as { co_value_id: RawCoID }[];
    return rows.map((row) => row.co_value_id);
  }

  trackCoValuesSyncState(
    updates: { id: RawCoID; peerId: PeerID; synced: boolean }[],
  ): void {
    for (const update of updates) {
      if (update.synced) {
        this.db.run(
          "DELETE FROM unsynced_covalues WHERE co_value_id = ? AND peer_id = ?",
          [update.id, update.peerId],
        );
      } else {
        this.db.run(
          "INSERT OR REPLACE INTO unsynced_covalues (co_value_id, peer_id) VALUES (?, ?)",
          [update.id, update.peerId],
        );
      }
    }
  }

  stopTrackingSyncState(id: RawCoID): void {
    this.db.run("DELETE FROM unsynced_covalues WHERE co_value_id = ?", [id]);
  }

  tryAcquireStorageReconciliationLock(
    sessionId: SessionID,
    peerId: PeerID,
  ): StorageReconciliationAcquireResult {
    let result: StorageReconciliationAcquireResult = {
      acquired: false,
      reason: "not_due",
    };
    this.transaction(() => {
      const now = Date.now();
      const lockKey = `lock#${peerId}`;
      const lockRow = this.getStorageReconciliationLock(lockKey);
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
      this.putStorageReconciliationLock({
        key: lockKey,
        holderSessionId: sessionId,
        acquiredAt: now,
        lastProcessedOffset,
      });
      result = { acquired: true, lastProcessedOffset };
    });
    return result;
  }

  renewStorageReconciliationLock(
    sessionId: SessionID,
    peerId: PeerID,
    offset: number,
  ): void {
    const lockKey = `lock#${peerId}`;
    const lockRow = this.getStorageReconciliationLock(lockKey);
    if (
      lockRow &&
      lockRow.holderSessionId === sessionId &&
      !lockRow.releasedAt
    ) {
      this.putStorageReconciliationLock({
        ...lockRow,
        lastProcessedOffset: offset,
      });
    }
  }

  releaseStorageReconciliationLock(sessionId: SessionID, peerId: PeerID): void {
    this.transaction(() => {
      const lockKey = `lock#${peerId}`;
      const releasedAt = Date.now();
      const lockRow = this.getStorageReconciliationLock(lockKey);
      if (lockRow?.holderSessionId === sessionId) {
        this.putStorageReconciliationLock({
          ...lockRow,
          releasedAt,
          lastProcessedOffset: 0,
        });
      }
    });
  }

  getCoValueKnownState(coValueId: string): CoValueKnownState | undefined {
    // First check if the CoValue exists
    const coValueRow = this.db.get<{ rowID: number }>(
      "SELECT rowID FROM coValues WHERE id = ?",
      [coValueId],
    );

    if (!coValueRow) {
      return undefined;
    }

    // Get all session counters without loading transactions
    const sessions = this.db.query<{ sessionID: SessionID; lastIdx: number }>(
      "SELECT sessionID, lastIdx FROM sessions WHERE coValue = ?",
      [coValueRow.rowID],
    );

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
