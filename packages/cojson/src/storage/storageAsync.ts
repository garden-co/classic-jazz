import {
  createContentMessage,
  exceedsRecommendedSize,
} from "../coValueContentMessage.js";
import {
  type CoValueCore,
  type RawCoID,
  type SessionID,
  type StorageAPI,
  logger,
} from "../exports.js";
import { StoreQueue } from "../queue/StoreQueue.js";
import { NewContentMessage, type PeerID } from "../sync.js";
import {
  CoValueKnownState,
  emptyKnownState,
  setSessionCounter,
} from "../knownState.js";
import { StorageKnownState } from "./knownState.js";
import { DeletedCoValuesEraserScheduler } from "./DeletedCoValuesEraserScheduler.js";
import {
  collectNewTxs,
  getDependedOnCoValues,
  getNewTransactionsSize,
} from "./syncUtils.js";
import type {
  CorrectionCallback,
  DBClientInterfaceAsync,
  DBTransactionInterfaceAsync,
  SignatureAfterRow,
  StoredCoValueRow,
  StoredSessionRow,
  StorageReconciliationAcquireResult,
  TransactionRow,
} from "./types.js";
import { isDeleteSessionID } from "../ids.js";

export class StorageApiAsync implements StorageAPI {
  private readonly dbClient: DBClientInterfaceAsync;

  private deletedCoValuesEraserScheduler:
    | DeletedCoValuesEraserScheduler
    | undefined;
  private eraserController: AbortController | undefined;
  /**
   * Keeps track of CoValues that are in memory, to avoid reloading them from storage
   * when it isn't necessary
   */
  private inMemoryCoValues = new Set<RawCoID>();

  // Track pending loads to deduplicate concurrent requests
  private pendingKnownStateLoads = new Map<
    string,
    Promise<CoValueKnownState | undefined>
  >();

  constructor(dbClient: DBClientInterfaceAsync) {
    this.dbClient = dbClient;
  }

  knownStates = new StorageKnownState();

  getKnownState(id: string): CoValueKnownState {
    return this.knownStates.getKnownState(id);
  }

  loadKnownState(
    id: string,
    callback: (knownState: CoValueKnownState | undefined) => void,
  ): void {
    // Check in-memory cache first
    const cached = this.knownStates.getCachedKnownState(id);
    if (cached) {
      callback(cached);
      return;
    }

    // Check if there's already a pending load for this ID (deduplication)
    const pending = this.pendingKnownStateLoads.get(id);
    if (pending) {
      // Ensure callback is always called, even if pending fails unexpectedly
      pending.then(callback, () => callback(undefined));
      return;
    }

    // Start new load and track it for deduplication
    const loadPromise = this.dbClient
      .getCoValueKnownState(id)
      .then((knownState) => {
        if (knownState) {
          // Cache for future use
          this.knownStates.setKnownState(id, knownState);
        }
        return knownState;
      })
      .catch((err) => {
        // Error handling contract:
        // - Log warning
        // - Behave like "not found" so callers can fall back (full load / load from peers)
        logger.warn("Failed to load knownState from storage", { id, err });
        return undefined;
      })
      .finally(() => {
        // Remove from pending map after completion (success or failure)
        this.pendingKnownStateLoads.delete(id);
      });

    this.pendingKnownStateLoads.set(id, loadPromise);
    loadPromise.then(callback);
  }

  async load(
    id: string,
    callback: (data: NewContentMessage) => void,
    done: (found: boolean) => void,
  ) {
    await this.loadCoValue(id, callback, done);
  }

  async loadCoValue(
    id: string,
    callback: (data: NewContentMessage) => void,
    done: (found: boolean) => void,
  ) {
    this.interruptEraser("load");
    const coValueRow = await this.dbClient.getCoValue(id);

    if (!coValueRow) {
      done?.(false);
      return;
    }

    const allCoValueSessions = await this.dbClient.getCoValueSessions(
      coValueRow.rowID,
    );

    const signaturesBySession = new Map<
      SessionID,
      Pick<SignatureAfterRow, "idx" | "signature">[]
    >();

    let contentStreaming = false;

    const signaturesByRowID = await this.getSignaturesByRowID(
      coValueRow.rowID,
      allCoValueSessions,
    );

    for (const sessionRow of allCoValueSessions) {
      const signatures = signaturesByRowID.get(sessionRow.rowID);

      if (signatures?.length) {
        contentStreaming = true;
        signaturesBySession.set(sessionRow.sessionID, signatures);
      }
    }

    // Without stored signatures every session's requested range is its whole
    // transaction log, so all of them can be fetched in a single query rather
    // than one per session. Streaming coValues keep the per-range reads.
    const prefetchedTxs = contentStreaming
      ? undefined
      : await this.getTransactionsByRowID(coValueRow.rowID);

    const knownState = this.knownStates.getKnownState(coValueRow.id);
    knownState.header = true;

    for (const sessionRow of allCoValueSessions) {
      setSessionCounter(
        knownState.sessions,
        sessionRow.sessionID,
        sessionRow.lastIdx,
      );
    }

    this.inMemoryCoValues.add(coValueRow.id);

    let contentMessage = createContentMessage(coValueRow.id, coValueRow.header);

    if (contentStreaming) {
      contentMessage.expectContentUntil = knownState.sessions;
    }

    for (const sessionRow of allCoValueSessions) {
      const signatures = signaturesBySession.get(sessionRow.sessionID) || [];

      let idx = 0;

      const lastSignature = signatures[signatures.length - 1];

      if (lastSignature?.signature !== sessionRow.lastSignature) {
        signatures.push({
          idx: sessionRow.lastIdx - 1,
          signature: sessionRow.lastSignature,
        });
      }

      for (const signature of signatures) {
        const newTxsInSession =
          prefetchedTxs?.get(sessionRow.rowID) ??
          (await this.dbClient.getNewTransactionInSession(
            sessionRow.rowID,
            idx,
            signature.idx,
          ));

        collectNewTxs({
          newTxsInSession,
          contentMessage,
          sessionRow,
          firstNewTxIdx: idx,
          signature: signature.signature,
        });

        idx = signature.idx + 1;

        if (signatures.length > 1) {
          // Having more than one signature means that the content needs streaming
          // So we start pushing the content to the client, and start a new content message
          await this.pushContentWithDependencies(
            coValueRow,
            contentMessage,
            callback,
          );
          contentMessage = createContentMessage(
            coValueRow.id,
            coValueRow.header,
          );
        }
      }
    }

    const hasNewContent = Object.keys(contentMessage.new).length > 0;

    // If there is no new content but steaming is not active, it's the case for a coValue with the header but no transactions
    // For streaming the push has already been done in the loop above
    if (hasNewContent || !contentStreaming) {
      await this.pushContentWithDependencies(
        coValueRow,
        contentMessage,
        callback,
      );
    }

    this.knownStates.handleUpdate(coValueRow.id, knownState);
    done?.(true);
  }

  /**
   * Groups rows carrying a `ses` column by that session rowID.
   */
  private groupBySession<T extends { ses: number }>(
    rows: T[],
  ): Map<number, T[]> {
    const bySession = new Map<number, T[]>();

    for (const row of rows) {
      const existing = bySession.get(row.ses);

      if (existing) {
        existing.push(row);
      } else {
        bySession.set(row.ses, [row]);
      }
    }

    return bySession;
  }

  /**
   * Every stored signature for a coValue, keyed by session rowID.
   *
   * Loading a coValue used to cost one signature query per session — with the
   * transaction query below, `2 + 2 * sessions` reads per coValue. Signatures
   * are rare (they only exist for content large enough to need streaming), so
   * the overwhelming majority of those queries returned nothing.
   */
  private async getSignaturesByRowID(
    coValueRowId: number,
    sessions: StoredSessionRow[],
  ): Promise<Map<number, Pick<SignatureAfterRow, "idx" | "signature">[]>> {
    if (this.dbClient.getSignaturesForCoValue) {
      return this.groupBySession(
        await this.dbClient.getSignaturesForCoValue(coValueRowId),
      );
    }

    const bySession = new Map<
      number,
      Pick<SignatureAfterRow, "idx" | "signature">[]
    >();

    await Promise.all(
      sessions.map(async (sessionRow) => {
        const signatures = await this.dbClient.getSignatures(
          sessionRow.rowID,
          0,
        );

        if (signatures.length > 0) {
          bySession.set(sessionRow.rowID, signatures);
        }
      }),
    );

    return bySession;
  }

  /**
   * Every transaction for a coValue, keyed by session rowID, or `undefined`
   * when the client can't batch and the caller should read per session.
   */
  private async getTransactionsByRowID(
    coValueRowId: number,
  ): Promise<Map<number, TransactionRow[]> | undefined> {
    if (!this.dbClient.getAllTransactionsForCoValue) {
      return undefined;
    }

    return this.groupBySession(
      await this.dbClient.getAllTransactionsForCoValue(coValueRowId),
    );
  }

  private async pushContentWithDependencies(
    coValueRow: StoredCoValueRow,
    contentMessage: NewContentMessage,
    pushCallback: (data: NewContentMessage) => void,
  ) {
    const dependedOnCoValuesList = getDependedOnCoValues(
      coValueRow.header,
      contentMessage,
    );

    const promises = [];

    for (const dependedOnCoValue of dependedOnCoValuesList) {
      if (this.inMemoryCoValues.has(dependedOnCoValue)) {
        continue;
      }

      promises.push(
        new Promise((resolve) => {
          this.loadCoValue(dependedOnCoValue, pushCallback, resolve);
        }),
      );
    }

    await Promise.all(promises);

    pushCallback(contentMessage);
  }

  storeQueue = new StoreQueue();

  async store(
    msg: NewContentMessage,
    correctionCallback: CorrectionCallback,
    done?: () => void,
  ) {
    /**
     * The store operations must be done one by one, because we can't start a new transaction when there
     * is already a transaction open.
     */
    this.storeQueue.push(msg, correctionCallback, done);

    this.storeQueue.processQueue(async (data, correctionCallback, done) => {
      this.interruptEraser("store");
      const success = await this.storeSingle(data, correctionCallback);

      if (success) {
        done?.();
      }

      return success;
    });
  }

  private interruptEraser(reason: string) {
    // Cooperative cancellation: a DB transaction already in progress will complete,
    // but the eraser loop will stop starting further work at its next abort check.
    if (this.eraserController) {
      this.eraserController.abort(reason);
      this.eraserController = undefined;
    }
  }

  async eraseAllDeletedCoValues() {
    const ids = await this.dbClient.getAllCoValuesWaitingForDelete();

    this.eraserController = new AbortController();
    const signal = this.eraserController.signal;

    for (const id of ids) {
      if (signal.aborted) {
        return;
      }

      await this.dbClient.eraseCoValueButKeepTombstone(id);
    }
  }

  /**
   * This function is called when the storage lacks the information required to store the incoming content.
   *
   * It triggers a `correctionCallback` to ask the syncManager to provide the missing information.
   *
   * The correction is applied immediately, to ensure that, when applicable, the dependent content in the queue won't require additional corrections.
   */
  private async handleCorrection(
    knownState: CoValueKnownState,
    correctionCallback: CorrectionCallback,
  ) {
    const correction = correctionCallback(knownState);

    if (!correction) {
      logger.error("Correction callback returned undefined", {
        knownState,
        correction: correction ?? null,
      });
      return false;
    }

    for (const msg of correction) {
      const success = await this.storeSingle(msg, (knownState) => {
        logger.error("Double correction requested", {
          msg,
          knownState,
        });
        return undefined;
      });

      if (!success) {
        return false;
      }
    }

    return true;
  }

  private async storeSingle(
    msg: NewContentMessage,
    correctionCallback: CorrectionCallback,
  ): Promise<boolean> {
    this.interruptEraser("store");
    if (this.storeQueue.closed) {
      return false;
    }

    const id = msg.id;
    const storedCoValueRowID = await this.dbClient.upsertCoValue(
      id,
      msg.header,
    );

    if (!storedCoValueRowID) {
      const knownState = emptyKnownState(id as RawCoID);
      this.knownStates.setKnownState(id, knownState);

      return this.handleCorrection(knownState, correctionCallback);
    }

    const knownState = this.knownStates.getKnownState(id);
    knownState.header = true;

    let invalidAssumptions = false;

    for (const sessionID of Object.keys(msg.new) as SessionID[]) {
      await this.dbClient.transaction(async (tx) => {
        const sessionRow = await tx.getSingleCoValueSession(
          storedCoValueRowID,
          sessionID,
        );

        if (this.deletedValues.has(id) && isDeleteSessionID(sessionID)) {
          await tx.markCoValueAsDeleted(id);
        }

        if (sessionRow) {
          setSessionCounter(
            knownState.sessions,
            sessionRow.sessionID,
            sessionRow.lastIdx,
          );
        }

        const lastIdx = sessionRow?.lastIdx || 0;
        const after = msg.new[sessionID]?.after || 0;

        if (lastIdx < after) {
          invalidAssumptions = true;
        } else {
          const newLastIdx = await this.putNewTxs(
            tx,
            msg,
            sessionID,
            sessionRow,
            storedCoValueRowID,
          );
          setSessionCounter(knownState.sessions, sessionID, newLastIdx);
        }
      });
    }

    this.inMemoryCoValues.add(id);

    this.knownStates.handleUpdate(id, knownState);

    if (invalidAssumptions) {
      return this.handleCorrection(knownState, correctionCallback);
    }

    return true;
  }

  private async putNewTxs(
    tx: DBTransactionInterfaceAsync,
    msg: NewContentMessage,
    sessionID: SessionID,
    sessionRow: StoredSessionRow | undefined,
    storedCoValueRowID: number,
  ) {
    const newTransactions = msg.new[sessionID]?.newTransactions || [];
    const lastIdx = sessionRow?.lastIdx || 0;

    const actuallyNewOffset = lastIdx - (msg.new[sessionID]?.after || 0);

    const actuallyNewTransactions = newTransactions.slice(actuallyNewOffset);

    if (actuallyNewTransactions.length === 0) {
      return lastIdx;
    }

    let bytesSinceLastSignature = sessionRow?.bytesSinceLastSignature || 0;
    const newTransactionsSize = getNewTransactionsSize(actuallyNewTransactions);

    const newLastIdx = lastIdx + actuallyNewTransactions.length;

    let shouldWriteSignature = false;

    if (exceedsRecommendedSize(bytesSinceLastSignature, newTransactionsSize)) {
      shouldWriteSignature = true;
      bytesSinceLastSignature = 0;
    } else {
      bytesSinceLastSignature += newTransactionsSize;
    }

    const nextIdx = lastIdx;

    if (!msg.new[sessionID]) throw new Error("Session ID not found");

    const sessionUpdate = {
      coValue: storedCoValueRowID,
      sessionID,
      lastIdx: newLastIdx,
      lastSignature: msg.new[sessionID].lastSignature,
      bytesSinceLastSignature,
    };

    const sessionRowID: number = await tx.addSessionUpdate({
      sessionUpdate,
      sessionRow,
    });

    if (shouldWriteSignature) {
      await tx.addSignatureAfter({
        sessionRowID,
        idx: newLastIdx - 1,
        signature: msg.new[sessionID].lastSignature,
      });
    }

    await Promise.all(
      actuallyNewTransactions.map((newTransaction, i) =>
        tx.addTransaction(sessionRowID, nextIdx + i, newTransaction),
      ),
    );

    return newLastIdx;
  }

  deletedValues = new Set<RawCoID>();

  markDeleteAsValid(id: RawCoID) {
    this.deletedValues.add(id);

    if (this.deletedCoValuesEraserScheduler) {
      this.deletedCoValuesEraserScheduler.onEnqueueDeletedCoValue();
    }
  }

  enableDeletedCoValuesErasure() {
    if (this.deletedCoValuesEraserScheduler) return;

    this.deletedCoValuesEraserScheduler = new DeletedCoValuesEraserScheduler({
      run: async () => {
        // Async storage: no max-time budgeting; drain to completion when scheduled.
        await this.eraseAllDeletedCoValues();
        const remaining = await this.dbClient.getAllCoValuesWaitingForDelete();
        return { hasMore: remaining.length > 0 };
      },
    });
    this.deletedCoValuesEraserScheduler.scheduleStartupDrain();
  }

  waitForSync(id: string, coValue: CoValueCore) {
    return this.knownStates.waitForSync(id, coValue);
  }

  trackCoValuesSyncState(
    updates: { id: RawCoID; peerId: PeerID; synced: boolean }[],
    done?: () => void,
  ): void {
    this.dbClient.trackCoValuesSyncState(updates).then(() => done?.());
  }

  getCoValueIDs(
    limit: number,
    offset: number,
    callback: (batch: { id: RawCoID }[]) => void,
  ): void {
    this.dbClient.getCoValueIDs(limit, offset).then(callback);
  }

  getCoValueCount(callback: (count: number) => void): void {
    this.dbClient.getCoValueCount().then(callback);
  }

  tryAcquireStorageReconciliationLock(
    sessionId: SessionID,
    peerId: PeerID,
    callback: (result: StorageReconciliationAcquireResult) => void,
  ): void {
    this.dbClient
      .tryAcquireStorageReconciliationLock(sessionId, peerId)
      .then(callback);
  }

  renewStorageReconciliationLock(
    sessionId: SessionID,
    peerId: PeerID,
    offset: number,
  ): void {
    this.dbClient.renewStorageReconciliationLock(sessionId, peerId, offset);
  }

  releaseStorageReconciliationLock(sessionId: SessionID, peerId: PeerID): void {
    this.dbClient.releaseStorageReconciliationLock(sessionId, peerId);
  }

  getUnsyncedCoValueIDs(
    callback: (unsyncedCoValueIDs: RawCoID[]) => void,
  ): void {
    this.dbClient.getUnsyncedCoValueIDs().then(callback);
  }

  stopTrackingSyncState(id: RawCoID): void {
    this.dbClient.stopTrackingSyncState(id);
  }

  onCoValueUnmounted(id: RawCoID): void {
    this.inMemoryCoValues.delete(id);
    this.knownStates.deleteKnownState(id);
  }

  close() {
    this.deletedCoValuesEraserScheduler?.dispose();
    this.inMemoryCoValues.clear();
    this.knownStates.clear();
    return this.storeQueue.close();
  }
}
