import {
  createContentMessage,
  exceedsRecommendedSize,
} from "../coValueContentMessage.js";
import {
  CoValueCore,
  RawCoID,
  type SessionID,
  type StorageAPI,
  logger,
} from "../exports.js";
import { NewContentMessage, type PeerID } from "../sync.js";
import { StorageKnownState } from "./knownState.js";
import {
  CoValueKnownState,
  emptyKnownState,
  setSessionCounter,
} from "../knownState.js";
import { isDeleteSessionID } from "../ids.js";
import {
  collectNewTxs,
  getDependedOnCoValues,
  getNewTransactionsSize,
} from "./syncUtils.js";
import type {
  CorrectionCallback,
  DBClientInterfaceSync,
  DBTransactionInterfaceSync,
  ReplaceSessionHistoryInput,
  SignatureAfterRow,
  StoredCoValueRow,
  StoredSessionRow,
  StorageReconciliationAcquireResult,
} from "./types.js";
import { DeletedCoValuesEraserScheduler } from "./DeletedCoValuesEraserScheduler.js";
import {
  ContentCallback,
  StorageStreamingQueue,
} from "../queue/StorageStreamingQueue.js";
import { getPriorityFromHeader } from "../priority.js";

const MAX_DELETE_SCHEDULE_DURATION_MS = 100;

export class StorageApiSync implements StorageAPI {
  private readonly dbClient: DBClientInterfaceSync;

  private deletedCoValuesEraserScheduler:
    | DeletedCoValuesEraserScheduler
    | undefined;
  /**
   * Keeps track of CoValues that are in memory, to avoid reloading them from storage
   * when it isn't necessary
   */
  private inMemoryCoValues = new Set<RawCoID>();

  /**
   * Queue for streaming content that will be pulled by SyncManager.
   * Only used when content requires streaming (multiple chunks).
   */
  readonly streamingQueue: StorageStreamingQueue;

  constructor(dbClient: DBClientInterfaceSync) {
    this.dbClient = dbClient;
    this.streamingQueue = new StorageStreamingQueue();
  }

  knownStates = new StorageKnownState();

  getKnownState(id: string): CoValueKnownState {
    return this.knownStates.getKnownState(id);
  }

  getCoValueIDs(
    limit: number,
    offset: number,
    callback: (batch: { id: RawCoID }[]) => void,
  ): void {
    const batch = this.dbClient.getCoValueIDs(limit, offset);
    callback(batch);
  }

  getCoValueCount(callback: (count: number) => void): void {
    callback(this.dbClient.getCoValueCount());
  }

  tryAcquireStorageReconciliationLock(
    sessionId: SessionID,
    peerId: PeerID,
    callback: (result: StorageReconciliationAcquireResult) => void,
  ): void {
    const result = this.dbClient.tryAcquireStorageReconciliationLock(
      sessionId,
      peerId,
    );
    callback(result);
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

  loadKnownState(
    id: string,
    callback: (knownState: CoValueKnownState | undefined) => void,
  ): void {
    callback(this.dbClient.getCoValueKnownState(id));
  }

  async load(
    id: string,
    callback: (data: NewContentMessage) => void,
    done: (found: boolean) => void,
  ) {
    await this.loadCoValue(id, callback, done);
  }

  loadCoValue(
    id: string,
    callback: (data: NewContentMessage) => void,
    done?: (found: boolean) => void,
  ) {
    const coValueRow = this.dbClient.getCoValue(id);

    if (!coValueRow) {
      done?.(false);
      return;
    }

    const allCoValueSessions = this.dbClient.getCoValueSessions(
      coValueRow.rowID,
    );

    const signaturesBySession = new Map<
      SessionID,
      Pick<SignatureAfterRow, "idx" | "signature">[]
    >();

    let contentStreaming = false;
    for (const sessionRow of allCoValueSessions) {
      const signatures = this.dbClient.getSignatures(sessionRow.rowID, 0);

      if (signatures.length > 0) {
        contentStreaming = true;
      }

      const lastSignature = signatures[signatures.length - 1];

      if (lastSignature?.signature !== sessionRow.lastSignature) {
        signatures.push({
          idx: sessionRow.lastIdx - 1,
          signature: sessionRow.lastSignature,
        });
      }

      signaturesBySession.set(sessionRow.sessionID, signatures);
    }

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

    const priority = getPriorityFromHeader(coValueRow.header);
    const contentMessage = createContentMessage(
      coValueRow.id,
      coValueRow.header,
    );

    if (contentStreaming) {
      contentMessage.expectContentUntil = knownState.sessions;
    }

    const streamingQueue: ContentCallback[] = [];

    for (const sessionRow of allCoValueSessions) {
      const signatures = signaturesBySession.get(sessionRow.sessionID);

      if (!signatures) {
        throw new Error("Signatures not found for session");
      }

      const firstSignature = signatures[0];

      if (!firstSignature) {
        continue;
      }

      this.loadSessionTransactions(
        contentMessage,
        sessionRow,
        0,
        firstSignature,
      );

      for (let i = 1; i < signatures.length; i++) {
        const prevSignature = signatures[i - 1];

        if (!prevSignature) {
          throw new Error("Previous signature is nullish");
        }

        streamingQueue.push(() => {
          const contentMessage = createContentMessage(
            coValueRow.id,
            coValueRow.header,
          );

          const signature = signatures[i];
          if (!signature) throw new Error("Signature item is nullish");

          this.loadSessionTransactions(
            contentMessage,
            sessionRow,
            prevSignature.idx + 1,
            signature,
          );

          if (Object.keys(contentMessage.new).length > 0) {
            this.pushContentWithDependencies(
              coValueRow,
              contentMessage,
              callback,
            );
          }
        });
      }
    }

    // Send the first chunk
    this.pushContentWithDependencies(coValueRow, contentMessage, callback);
    this.knownStates.handleUpdate(coValueRow.id, knownState);

    // All priorities go through the queue (HIGH > MEDIUM > LOW)
    for (const pushStreamingContent of streamingQueue) {
      this.streamingQueue.push(pushStreamingContent, priority);
    }

    // Trigger the queue to process the entries
    if (streamingQueue.length > 0) {
      this.streamingQueue.emit();
    }

    done?.(true);
  }

  private loadSessionTransactions(
    contentMessage: NewContentMessage,
    sessionRow: StoredSessionRow,
    idx: number,
    signature: Pick<SignatureAfterRow, "idx" | "signature">,
  ) {
    const newTxsInSession = this.dbClient.getNewTransactionInSession(
      sessionRow.rowID,
      idx,
      signature.idx,
    );

    collectNewTxs({
      newTxsInSession,
      contentMessage,
      sessionRow,
      firstNewTxIdx: idx,
      signature: signature.signature,
    });
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

    for (const dependedOnCoValue of dependedOnCoValuesList) {
      if (this.inMemoryCoValues.has(dependedOnCoValue)) {
        continue;
      }

      this.loadCoValue(dependedOnCoValue, pushCallback);
    }

    pushCallback(contentMessage);
  }

  store(
    msg: NewContentMessage | ReplaceSessionHistoryInput,
    correctionCallback: CorrectionCallback,
  ): void {
    if ("action" in msg && msg.action === "replaceSessionHistory") {
      this.storeSingleSessionReplacement(msg);
      return;
    }

    // Return value used by internal callers (storeSingle returns boolean)
    return this.storeSingle(msg, correctionCallback) as unknown as void;
  }

  private storeSingleSessionReplacement(msg: ReplaceSessionHistoryInput): void {
    const coValueRow = this.dbClient.getCoValue(msg.coValueId);
    if (!coValueRow) {
      logger.warn("replaceSessionHistory: CoValue not found", {
        id: msg.coValueId,
      });
      return;
    }

    // Delete existing session content
    this.dbClient.deleteSessionContent(coValueRow.rowID, msg.sessionID);

    // Write new authoritative content
    for (const piece of msg.content) {
      this.dbClient.transaction((tx) => {
        const sessionRow = tx.getSingleCoValueSession(
          coValueRow.rowID,
          msg.sessionID,
        );
        this.putNewTxs(
          tx,
          {
            id: msg.coValueId,
            action: "content",
            priority: 6 as const,
            new: {
              [msg.sessionID]: piece,
            },
          } as NewContentMessage,
          msg.sessionID,
          sessionRow,
          coValueRow.rowID,
        );
      });
    }

    // Update known state from authoritative content
    const knownState = this.knownStates.getKnownState(msg.coValueId);
    knownState.header = true;

    const lastPiece = msg.content[msg.content.length - 1];
    if (lastPiece) {
      setSessionCounter(
        knownState.sessions,
        msg.sessionID,
        lastPiece.after + lastPiece.newTransactions.length,
      );
    }
    this.knownStates.handleUpdate(msg.coValueId, knownState);
  }

  /**
   * This function is called when the storage lacks the information required to store the incoming content.
   *
   * It triggers a `correctionCallback` to ask the syncManager to provide the missing information.
   */
  private handleCorrection(
    knownState: CoValueKnownState,
    correctionCallback: CorrectionCallback,
  ) {
    const correction = correctionCallback(knownState);

    if (!correction) {
      logger.error("Correction callback returned undefined", {
        knownState,
      });
      return false;
    }

    for (const msg of correction) {
      const success = this.storeSingle(msg, (knownState) => {
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

  private storeSingle(
    msg: NewContentMessage,
    correctionCallback: CorrectionCallback,
  ): boolean {
    const id = msg.id;
    const storedCoValueRowID = this.dbClient.upsertCoValue(id, msg.header);

    if (!storedCoValueRowID) {
      const knownState = emptyKnownState(id as RawCoID);
      this.knownStates.setKnownState(id, knownState);

      return this.handleCorrection(knownState, correctionCallback);
    }

    const knownState = this.knownStates.getKnownState(id);
    knownState.header = true;

    let invalidAssumptions = false;

    for (const sessionID of Object.keys(msg.new) as SessionID[]) {
      this.dbClient.transaction((tx) => {
        if (this.deletedValues.has(id) && isDeleteSessionID(sessionID)) {
          tx.markCoValueAsDeleted(id);
        }

        const sessionRow = tx.getSingleCoValueSession(
          storedCoValueRowID,
          sessionID,
        );

        if (sessionRow) {
          setSessionCounter(
            knownState.sessions,
            sessionRow.sessionID,
            sessionRow.lastIdx,
          );
        }

        if ((sessionRow?.lastIdx || 0) < (msg.new[sessionID]?.after || 0)) {
          invalidAssumptions = true;
        } else {
          const newLastIdx = this.putNewTxs(
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

  private putNewTxs(
    tx: DBTransactionInterfaceSync,
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

    const newLastIdx =
      (sessionRow?.lastIdx || 0) + actuallyNewTransactions.length;

    let shouldWriteSignature = false;

    if (exceedsRecommendedSize(bytesSinceLastSignature, newTransactionsSize)) {
      shouldWriteSignature = true;
      bytesSinceLastSignature = 0;
    } else {
      bytesSinceLastSignature += newTransactionsSize;
    }

    const nextIdx = sessionRow?.lastIdx || 0;

    if (!msg.new[sessionID]) throw new Error("Session ID not found");

    const sessionUpdate = {
      coValue: storedCoValueRowID,
      sessionID,
      lastIdx: newLastIdx,
      lastSignature: msg.new[sessionID].lastSignature,
      bytesSinceLastSignature,
    };

    const sessionRowID: number = tx.addSessionUpdate({
      sessionUpdate,
      sessionRow,
    });

    if (shouldWriteSignature) {
      tx.addSignatureAfter({
        sessionRowID,
        idx: newLastIdx - 1,
        signature: msg.new[sessionID].lastSignature,
      });
    }

    actuallyNewTransactions.map((newTransaction, i) =>
      tx.addTransaction(sessionRowID, nextIdx + i, newTransaction),
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

  async eraseAllDeletedCoValues(): Promise<void> {
    const ids = this.dbClient.getAllCoValuesWaitingForDelete();

    for (const id of ids) {
      this.dbClient.eraseCoValueButKeepTombstone(id);
    }
  }

  enableDeletedCoValuesErasure() {
    if (this.deletedCoValuesEraserScheduler) return;
    this.deletedCoValuesEraserScheduler = new DeletedCoValuesEraserScheduler({
      run: async () =>
        this.eraseDeletedCoValuesOnceBudgeted(MAX_DELETE_SCHEDULE_DURATION_MS),
    });
    this.deletedCoValuesEraserScheduler.scheduleStartupDrain();
  }

  private eraseDeletedCoValuesOnceBudgeted(budgetMs?: number) {
    const startedAt = Date.now();
    const ids = this.dbClient.getAllCoValuesWaitingForDelete();

    for (const id of ids) {
      // Strict time budget for sync storage to avoid blocking.
      if (budgetMs && Date.now() - startedAt >= budgetMs) {
        break;
      }

      this.dbClient.eraseCoValueButKeepTombstone(id);
    }

    return {
      hasMore: this.dbClient.getAllCoValuesWaitingForDelete().length > 0,
    };
  }

  waitForSync(id: string, coValue: CoValueCore) {
    return this.knownStates.waitForSync(id, coValue);
  }

  trackCoValuesSyncState(
    updates: { id: RawCoID; peerId: PeerID; synced: boolean }[],
    done?: () => void,
  ): void {
    this.dbClient.trackCoValuesSyncState(updates);
    done?.();
  }

  getUnsyncedCoValueIDs(
    callback: (unsyncedCoValueIDs: RawCoID[]) => void,
  ): void {
    const ids = this.dbClient.getUnsyncedCoValueIDs();
    callback(ids);
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
    return undefined;
  }
}
