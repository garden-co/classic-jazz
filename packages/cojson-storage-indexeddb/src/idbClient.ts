import type {
  CojsonInternalTypes,
  RawCoID,
  SessionID,
  DBTransactionInterfaceAsync,
} from "cojson";
import type {
  CoValueRow,
  DBClientInterfaceAsync,
  SessionRow,
  SignatureAfterRow,
  StorageReconciliationLockRow,
  StoredCoValueRow,
  StoredSessionRow,
  TransactionRow,
  StorageReconciliationAcquireResult,
} from "cojson";
import { cojsonInternals } from "cojson";
import {
  CoJsonIDBTransaction,
  putIndexedDbStore,
  queryIndexedDbStore,
  StoreName,
} from "./CoJsonIDBTransaction.js";

type DeletedCoValueQueueEntry = {
  coValueID: RawCoID;
  status?: "pending" | "done";
};

/**
 * Contains operations that should run as part of a readwrite transaction.
 *
 * Everything in this class is meant to be executed sequentially and never
 * concurrently, across all the data stores and tabs.
 */
export class IDBTransaction implements DBTransactionInterfaceAsync {
  constructor(private tx: CoJsonIDBTransaction) {}

  private async run<T>(
    handler: (txEntry: CoJsonIDBTransaction) => IDBRequest<T>,
  ): Promise<T> {
    return this.tx.handleRequest<T>(handler);
  }

  async getSingleCoValueSession(
    coValueRowId: number,
    sessionID: SessionID,
  ): Promise<StoredSessionRow | undefined> {
    return this.run((tx) =>
      tx
        .getObjectStore("sessions")
        .index("uniqueSessions")
        .get([coValueRowId, sessionID]),
    );
  }

  async markCoValueAsDeleted(id: RawCoID): Promise<void> {
    await this.run((tx) =>
      tx.getObjectStore("deletedCoValues").put({
        coValueID: id,
        status: "pending",
      } satisfies DeletedCoValueQueueEntry),
    );
  }

  async deleteCoValueContent(coValue: StoredCoValueRow): Promise<void> {
    const coValueRowID = coValue.rowID;

    const sessions = await this.run((tx) =>
      tx
        .getObjectStore("sessions")
        .index("sessionsByCoValue")
        .getAll(coValueRowID),
    );

    const sessionsToDelete = (
      sessions as { rowID: number; sessionID: string }[]
    )
      .filter((s) => !s.sessionID.endsWith("$"))
      .map((s) => s.rowID);

    const ops: Promise<unknown>[] = [];

    for (const sessionRowID of sessionsToDelete) {
      ops.push(
        this.#deleteAllBySesPrefix("transactions", sessionRowID),
        this.#deleteAllBySesPrefix("signatureAfter", sessionRowID),
        this.run((tx) => tx.getObjectStore("sessions").delete(sessionRowID)),
      );
    }

    ops.push(
      this.run((tx) =>
        tx.getObjectStore("deletedCoValues").put({
          coValueID: coValue.id,
          status: "done",
        } satisfies DeletedCoValueQueueEntry),
      ),
    );

    await Promise.all(ops);
  }

  async #deleteAllBySesPrefix(
    storeName: "transactions" | "signatureAfter",
    sesRowID: number,
  ) {
    const range = IDBKeyRange.bound(
      [sesRowID, 0],
      [sesRowID, Number.POSITIVE_INFINITY],
    );
    const keys = await this.run((tx) =>
      tx.getObjectStore(storeName).getAllKeys(range),
    );

    for (const key of keys as IDBValidKey[]) {
      await this.run((tx) => tx.getObjectStore(storeName).delete(key));
    }
  }

  async addSessionUpdate({
    sessionUpdate,
    sessionRow,
  }: {
    sessionUpdate: SessionRow;
    sessionRow?: StoredSessionRow;
  }): Promise<number> {
    return this.run<number>(
      (tx) =>
        tx.getObjectStore("sessions").put(
          sessionRow?.rowID
            ? {
                rowID: sessionRow.rowID,
                ...sessionUpdate,
              }
            : sessionUpdate,
        ) as IDBRequest<number>,
    );
  }

  async addTransaction(
    sessionRowID: number,
    idx: number,
    newTransaction: CojsonInternalTypes.Transaction,
  ) {
    await this.run((tx) =>
      tx.getObjectStore("transactions").add({
        ses: sessionRowID,
        idx,
        tx: newTransaction,
      } satisfies TransactionRow),
    );
  }

  async addSignatureAfter({
    sessionRowID,
    idx,
    signature,
  }: {
    sessionRowID: number;
    idx: number;
    signature: CojsonInternalTypes.Signature;
  }) {
    return this.run((tx) =>
      tx.getObjectStore("signatureAfter").put({
        ses: sessionRowID,
        idx,
        signature,
      }),
    );
  }

  /**
   * Get an unsynced CoValue record by coValueId and peerId.
   */
  async getUnsyncedCoValueRecord(
    coValueId: RawCoID,
    peerId: string,
  ): Promise<
    { rowID: number; coValueId: RawCoID; peerId: string } | undefined
  > {
    return this.run((tx) =>
      tx
        .getObjectStore("unsyncedCoValues")
        .index("uniqueUnsyncedCoValues")
        .get([coValueId, peerId]),
    );
  }

  /**
   * Get all unsynced CoValue records for a given coValueId.
   */
  async getAllUnsyncedCoValueRecords(
    coValueId: RawCoID,
  ): Promise<{ rowID: number; coValueId: RawCoID; peerId: string }[]> {
    return this.run((tx) =>
      tx
        .getObjectStore("unsyncedCoValues")
        .index("byCoValueId")
        .getAll(coValueId),
    );
  }

  /**
   * Delete an unsynced CoValue record by rowID.
   */
  async deleteUnsyncedCoValueRecord(rowID: number): Promise<void> {
    await this.run((tx) => tx.getObjectStore("unsyncedCoValues").delete(rowID));
  }

  /**
   * Insert or update an unsynced CoValue record.
   */
  async putUnsyncedCoValueRecord(record: {
    rowID?: number;
    coValueId: RawCoID;
    peerId: string;
  }): Promise<void> {
    await this.run((tx) => tx.getObjectStore("unsyncedCoValues").put(record));
  }

  async getStorageReconciliationLock(
    key: string,
  ): Promise<StorageReconciliationLockRow | undefined> {
    return this.run((tx) =>
      tx.getObjectStore("storageReconciliationLocks").get(key),
    );
  }

  async putStorageReconciliationLock(
    entry: StorageReconciliationLockRow,
  ): Promise<void> {
    await this.run((tx) =>
      tx.getObjectStore("storageReconciliationLocks").put(entry),
    );
  }
}

export class IDBClient implements DBClientInterfaceAsync {
  private db;
  private closed = false;

  activeTransaction: CoJsonIDBTransaction | undefined;
  autoBatchingTransaction: CoJsonIDBTransaction | undefined;

  constructor(db: IDBDatabase) {
    this.db = db;

    this.db.onclose = () => {
      this.closed = true;
    };
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    try {
      this.db.close();
    } catch {
      // Already closing
    }
  }

  isClosed() {
    return this.closed;
  }

  async getCoValue(coValueId: RawCoID): Promise<StoredCoValueRow | undefined> {
    return queryIndexedDbStore(this.db, "coValues", (store) =>
      store.index("coValuesById").get(coValueId),
    );
  }

  async getCoValueRowID(coValueId: RawCoID): Promise<number | undefined> {
    return this.getCoValue(coValueId).then((row) => row?.rowID);
  }

  async getCoValueSessions(coValueRowId: number): Promise<StoredSessionRow[]> {
    return queryIndexedDbStore(this.db, "sessions", (store) =>
      store.index("sessionsByCoValue").getAll(coValueRowId),
    );
  }

  async getNewTransactionInSession(
    sessionRowId: number,
    fromIdx: number,
    toIdx: number,
  ): Promise<TransactionRow[]> {
    return queryIndexedDbStore(this.db, "transactions", (store) =>
      store.getAll(
        IDBKeyRange.bound([sessionRowId, fromIdx], [sessionRowId, toIdx]),
      ),
    );
  }

  async getSignatures(
    sessionRowId: number,
    firstNewTxIdx: number,
  ): Promise<SignatureAfterRow[]> {
    return queryIndexedDbStore(this.db, "signatureAfter", (store) =>
      store.getAll(
        IDBKeyRange.bound(
          [sessionRowId, firstNewTxIdx],
          [sessionRowId, Number.POSITIVE_INFINITY],
        ),
      ),
    );
  }

  async upsertCoValue(
    id: RawCoID,
    header?: CojsonInternalTypes.CoValueHeader,
  ): Promise<number | undefined> {
    if (!header) {
      return this.getCoValueRowID(id);
    }

    return putIndexedDbStore<CoValueRow, number>(this.db, "coValues", {
      id,
      header,
    }).catch(() => this.getCoValueRowID(id));
  }

  async getAllCoValuesWaitingForDelete(): Promise<RawCoID[]> {
    const entries = await queryIndexedDbStore<DeletedCoValueQueueEntry[]>(
      this.db,
      "deletedCoValues",
      (store) =>
        store.index("deletedCoValuesByStatus").getAll("pending") as IDBRequest<
          DeletedCoValueQueueEntry[]
        >,
    );
    return entries.map((e) => e.coValueID);
  }

  async transaction(
    operationsCallback: (tx: IDBTransaction) => Promise<unknown>,
    storeNames?: StoreName[],
  ) {
    if (this.closed) return;

    const tx = new CoJsonIDBTransaction(this.db, storeNames);

    try {
      await operationsCallback(new IDBTransaction(tx));
      tx.commit(); // Tells the browser to not wait for another possible request and commit the transaction immediately
    } catch (error) {
      tx.rollback();
    }
  }

  async trackCoValuesSyncState(
    updates: { id: RawCoID; peerId: string; synced: boolean }[],
  ): Promise<void> {
    if (updates.length === 0) {
      return;
    }

    await this.transaction(
      async (tx) => {
        await Promise.all(
          updates.map(async (update) => {
            const record = await tx.getUnsyncedCoValueRecord(
              update.id,
              update.peerId,
            );
            if (update.synced) {
              // Delete
              if (record) {
                await tx.deleteUnsyncedCoValueRecord(record.rowID);
              }
            } else {
              // Insert or update
              await tx.putUnsyncedCoValueRecord(
                record
                  ? {
                      rowID: record.rowID,
                      coValueId: update.id,
                      peerId: update.peerId,
                    }
                  : {
                      coValueId: update.id,
                      peerId: update.peerId,
                    },
              );
            }
          }),
        );
      },
      ["unsyncedCoValues"],
    );
  }

  async eraseCoValueButKeepTombstone(coValueID: RawCoID): Promise<void> {
    const coValue = await this.getCoValue(coValueID);

    if (!coValue) {
      console.warn(`CoValue ${coValueID} not found, skipping deletion`);
      return;
    }

    await this.transaction((tx) => tx.deleteCoValueContent(coValue));
  }

  async getCoValueIDs(
    limit: number,
    offset: number,
  ): Promise<{ id: RawCoID }[]> {
    const rows = await queryIndexedDbStore<StoredCoValueRow[]>(
      this.db,
      "coValues",
      (store) =>
        // Include upper bound but not lower bound (offset starts at 0)
        store.getAll(IDBKeyRange.bound(offset, offset + limit, true, false)),
    );
    return rows.map((row) => ({ id: row.id }));
  }

  async getCoValueCount(): Promise<number> {
    return queryIndexedDbStore(this.db, "coValues", (store) => store.count());
  }

  async getUnsyncedCoValueIDs(): Promise<RawCoID[]> {
    const records = await queryIndexedDbStore<
      { rowID: number; coValueId: RawCoID; peerId: string }[]
    >(this.db, "unsyncedCoValues", (store) => store.getAll());
    const uniqueIds = new Set<RawCoID>();
    for (const record of records) {
      uniqueIds.add(record.coValueId);
    }
    return Array.from(uniqueIds);
  }

  async stopTrackingSyncState(id: RawCoID): Promise<void> {
    await this.transaction(
      async (tx) => {
        const idbTx = tx as IDBTransaction;
        const records = await idbTx.getAllUnsyncedCoValueRecords(id);
        await Promise.all(
          records.map((record) =>
            idbTx.deleteUnsyncedCoValueRecord(record.rowID),
          ),
        );
      },
      ["unsyncedCoValues"],
    );
  }

  async tryAcquireStorageReconciliationLock(
    sessionId: SessionID,
    peerId: string,
  ): Promise<StorageReconciliationAcquireResult> {
    const lockKey = `lock#${peerId}`;
    const now = Date.now();
    const { LOCK_TTL_MS, RECONCILIATION_INTERVAL_MS } =
      cojsonInternals.STORAGE_RECONCILIATION_CONFIG;

    let result: StorageReconciliationAcquireResult;
    await this.transaction(
      async (tx) => {
        const lock = await tx.getStorageReconciliationLock(lockKey);
        if (
          lock?.releasedAt &&
          now - lock.releasedAt < RECONCILIATION_INTERVAL_MS
        ) {
          result = { acquired: false, reason: "not_due" };
          return;
        }
        const expiresAt = lock ? lock.acquiredAt + LOCK_TTL_MS : 0;
        const isLockHeldByOtherSession = lock?.holderSessionId !== sessionId;
        if (
          lock &&
          !lock.releasedAt &&
          expiresAt >= now &&
          isLockHeldByOtherSession
        ) {
          result = { acquired: false, reason: "lock_held" };
          return;
        }
        const lastProcessedOffset =
          lock && !lock.releasedAt ? (lock.lastProcessedOffset ?? 0) : 0;
        await tx.putStorageReconciliationLock({
          key: lockKey,
          holderSessionId: sessionId,
          acquiredAt: now,
          lastProcessedOffset,
        });
        result = { acquired: true, lastProcessedOffset };
      },
      ["storageReconciliationLocks"],
    );
    return result!;
  }

  async renewStorageReconciliationLock(
    sessionId: SessionID,
    peerId: string,
    offset: number,
  ): Promise<void> {
    const lockKey = `lock#${peerId}`;
    await this.transaction(
      async (tx) => {
        const lock = await tx.getStorageReconciliationLock(lockKey);
        if (lock && lock.holderSessionId === sessionId && !lock.releasedAt) {
          await tx.putStorageReconciliationLock({
            ...lock,
            lastProcessedOffset: offset,
          });
        }
      },
      ["storageReconciliationLocks"],
    );
  }

  async releaseStorageReconciliationLock(
    sessionId: SessionID,
    peerId: string,
  ): Promise<void> {
    const lockKey = `lock#${peerId}`;
    const releasedAt = Date.now();

    await this.transaction(
      async (tx) => {
        const lock = await tx.getStorageReconciliationLock(lockKey);
        if (lock?.holderSessionId === sessionId) {
          await tx.putStorageReconciliationLock({
            ...lock,
            releasedAt,
            lastProcessedOffset: 0,
          });
        }
      },
      ["storageReconciliationLocks"],
    );
  }

  async getCoValueKnownState(
    coValueId: string,
  ): Promise<CojsonInternalTypes.CoValueKnownState | undefined> {
    // First check if the CoValue exists
    const coValueRow = await this.getCoValue(coValueId as RawCoID);

    if (!coValueRow) {
      return undefined;
    }

    // Get all session counters without loading transactions
    const sessions = await this.getCoValueSessions(coValueRow.rowID);

    const knownState: CojsonInternalTypes.CoValueKnownState = {
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
