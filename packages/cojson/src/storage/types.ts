import type {
  CoValueHeader,
  Transaction,
} from "../coValueCore/verifiedState.js";
import { Signature } from "../crypto/crypto.js";
import type { CoValueCore, RawCoID, SessionID } from "../exports.js";
import { NewContentMessage, type SessionNewContent } from "../sync.js";
import type { PeerID } from "../sync.js";
import { CoValueKnownState } from "../knownState.js";
import { StorageStreamingQueue } from "../queue/StorageStreamingQueue.js";

export type CorrectionCallback = (
  correction: CoValueKnownState,
) => NewContentMessage[] | undefined;

export type ReplaceSessionHistoryInput = {
  action: "replaceSessionHistory";
  coValueId: RawCoID;
  sessionID: SessionID;
  content: SessionNewContent[];
};

export type StorageReconciliationAcquireResult =
  | { acquired: true; lastProcessedOffset: number }
  | { acquired: false; reason: "not_due" | "lock_held" };

/**
 * Deletion work queue status for `deletedCoValues` (SQLite).
 *
 * Stored as an INTEGER in SQLite:
 * - 0 = pending
 * - 1 = done
 */
export enum DeletedCoValueDeletionStatus {
  Pending = 0,
  Done = 1,
}

/**
 * The StorageAPI is the interface that the StorageSync and StorageAsync classes implement.
 *
 * It uses callbacks instead of promises to have no overhead when using the StorageSync and less overhead when using the StorageAsync.
 */
export interface StorageAPI {
  /**
   * Flags that the coValue delete is valid.
   *
   * When the delete tx is stored, the storage will mark the coValue as deleted.
   */
  markDeleteAsValid(id: RawCoID): void;

  /**
   * Enable the background erasure scheduler that drains the `deletedCoValues` work queue.
   * This is intentionally opt-in and should be activated by `LocalNode`.
   */
  enableDeletedCoValuesErasure(): void;

  /**
   * Batch physical deletion for coValues queued in `deletedCoValues` with status `Pending`.
   * Must preserve tombstones (header + delete session(s) + their tx/signatures).
   */
  eraseAllDeletedCoValues(): Promise<void>;

  load(
    id: string,
    // This callback is fired when data is found, might be called multiple times if the content requires streaming (e.g when loading files)
    callback: (data: NewContentMessage) => void,
    done?: (found: boolean) => void,
  ): void;
  store(
    data: NewContentMessage | ReplaceSessionHistoryInput,
    handleCorrection: CorrectionCallback,
  ): void | Promise<void>;

  streamingQueue?: StorageStreamingQueue;

  getKnownState(id: string): CoValueKnownState;

  waitForSync(id: string, coValue: CoValueCore): Promise<void>;

  /**
   * Track multiple sync status updates.
   * Does not guarantee the updates will be applied in order, so only one
   * update per CoValue ID + Peer ID combination should be tracked at a time.
   */
  trackCoValuesSyncState(
    updates: { id: RawCoID; peerId: PeerID; synced: boolean }[],
    done?: () => void,
  ): void;

  /**
   * Get all CoValue IDs that have at least one unsynced peer.
   */
  getUnsyncedCoValueIDs(
    callback: (unsyncedCoValueIDs: RawCoID[]) => void,
  ): void;

  /**
   * Stop tracking sync status for a CoValue (remove all peer entries).
   */
  stopTrackingSyncState(id: RawCoID): void;

  /**
   * Get a batch of CoValue IDs from storage.
   * Used for full storage reconciliation. Call repeatedly with increasing offset
   * until the returned batch has length < limit (or 0) to enumerate all IDs.
   * @param limit - Max number of IDs to return (e.g. 100).
   * @param offset - Number of IDs to skip (0 for first batch).
   * @param callback - Called with the batch. Ordering must be stable (e.g. by id).
   */
  getCoValueIDs(
    limit: number,
    offset: number,
    callback: (batch: { id: RawCoID }[]) => void,
  ): void;

  /**
   * Get the total number of CoValues in storage.
   */
  getCoValueCount(callback: (count: number) => void): void;

  /**
   * Try to acquire the storage reconciliation lock for a given peer.
   * Atomically checks if reconciliation is due for this peer (lastRun older than 30 days or missing)
   * and if no other process/tab holds the lock for this peer, then acquires it.
   */
  tryAcquireStorageReconciliationLock(
    sessionId: SessionID,
    peerId: PeerID,
    callback: (result: StorageReconciliationAcquireResult) => void,
  ): void;

  /**
   * Update the last processed offset for the storage reconciliation lock held for this peer.
   * Only call after a batch has been acked; used to resume from this offset on interrupt.
   */
  renewStorageReconciliationLock(
    sessionId: SessionID,
    peerId: PeerID,
    offset: number,
  ): void;

  /**
   * Release the storage reconciliation lock for a peer and record completion. Only call on successful completion.
   * On failure/interrupt, do not call; the lock expires after LOCK_TTL_MS and another process can retry for this peer.
   */
  releaseStorageReconciliationLock(sessionId: SessionID, peerId: PeerID): void;

  /**
   * Load only the knownState (header presence + session counters) for a CoValue.
   * This is more efficient than load() when we only need to check if a peer needs new content.
   *
   * @param id - The CoValue ID
   * @param callback - Called with the knownState, or undefined if CoValue not found
   */
  loadKnownState(
    id: string,
    callback: (knownState: CoValueKnownState | undefined) => void,
  ): void;

  /**
   * Called when a CoValue is unmounted from memory.
   * Used to clean up the metadata associated with that CoValue.
   */
  onCoValueUnmounted(id: RawCoID): void;

  close(): Promise<unknown> | undefined;
}

export type CoValueRow = {
  id: RawCoID;
  header: CoValueHeader;
};

export type StoredCoValueRow = CoValueRow & { rowID: number };

export type SessionRow = {
  coValue: number;
  sessionID: SessionID;
  lastIdx: number;
  lastSignature: Signature;
  bytesSinceLastSignature?: number;
};

export type StoredSessionRow = SessionRow & { rowID: number };

export type TransactionRow = {
  ses: number;
  idx: number;
  tx: Transaction;
};

export type SignatureAfterRow = {
  ses: number;
  idx: number;
  signature: Signature;
};

export type StorageReconciliationLockRow = {
  key: string;
  holderSessionId: SessionID;
  acquiredAt: number;
  releasedAt?: number;
  /** Offset up to which all batches have been acked; used to resume after interrupt. */
  lastProcessedOffset: number;
};

export interface DBTransactionInterfaceAsync {
  getSingleCoValueSession(
    coValueRowId: number,
    sessionID: SessionID,
  ): Promise<StoredSessionRow | undefined>;

  /**
   * Persist a "deleted coValue" marker in storage (work queue entry).
   * This is an enqueue signal: implementations should set status to `Pending`.
   * This is expected to be idempotent (safe to call repeatedly).
   */
  markCoValueAsDeleted(id: RawCoID): Promise<unknown>;

  addSessionUpdate({
    sessionUpdate,
    sessionRow,
  }: {
    sessionUpdate: SessionRow;
    sessionRow?: StoredSessionRow;
  }): Promise<number>;

  addTransaction(
    sessionRowID: number,
    idx: number,
    newTransaction: Transaction,
  ): Promise<number> | undefined | unknown;

  addSignatureAfter({
    sessionRowID,
    idx,
    signature,
  }: {
    sessionRowID: number;
    idx: number;
    signature: Signature;
  }): Promise<unknown>;

  deleteCoValueContent(
    coValueRow: Pick<StoredCoValueRow, "rowID" | "id">,
  ): Promise<unknown>;

  getStorageReconciliationLock(
    key: string,
  ): Promise<StorageReconciliationLockRow | undefined>;

  putStorageReconciliationLock(
    entry: StorageReconciliationLockRow,
  ): Promise<void>;
}

export interface DBClientInterfaceAsync {
  getCoValue(
    coValueId: string,
  ): Promise<StoredCoValueRow | undefined> | undefined;

  upsertCoValue(
    id: string,
    header?: CoValueHeader,
  ): Promise<number | undefined>;

  /**
   * Enumerate all coValue IDs currently pending in the "deleted coValues" work queue.
   */
  getAllCoValuesWaitingForDelete(): Promise<RawCoID[]>;

  getCoValueSessions(coValueRowId: number): Promise<StoredSessionRow[]>;

  getNewTransactionInSession(
    sessionRowId: number,
    fromIdx: number,
    toIdx: number,
  ): Promise<TransactionRow[]>;

  getSignatures(
    sessionRowId: number,
    firstNewTxIdx: number,
  ): Promise<SignatureAfterRow[]>;

  deleteSessionContent(
    coValueRowId: number,
    sessionID: SessionID,
  ): Promise<void>;

  transaction(
    callback: (tx: DBTransactionInterfaceAsync) => Promise<unknown>,
  ): Promise<unknown>;

  trackCoValuesSyncState(
    updates: { id: RawCoID; peerId: PeerID; synced: boolean }[],
  ): Promise<void>;

  getUnsyncedCoValueIDs(): Promise<RawCoID[]>;

  stopTrackingSyncState(id: RawCoID): Promise<void>;

  /**
   * Physical deletion primitive: erase all persisted history for a deleted coValue,
   * while preserving the tombstone (header + delete session(s)).
   * Must run inside a single storage transaction.
   */
  eraseCoValueButKeepTombstone(coValueID: RawCoID): Promise<unknown>;

  /**
   * Get the knownState for a CoValue without loading transactions.
   * Returns undefined if the CoValue doesn't exist.
   */
  getCoValueKnownState(
    coValueId: string,
  ): Promise<CoValueKnownState | undefined>;

  getCoValueIDs(limit: number, offset: number): Promise<{ id: RawCoID }[]>;

  getCoValueCount(): Promise<number>;

  tryAcquireStorageReconciliationLock(
    sessionId: SessionID,
    peerId: PeerID,
  ): Promise<StorageReconciliationAcquireResult>;

  renewStorageReconciliationLock(
    sessionId: SessionID,
    peerId: PeerID,
    offset: number,
  ): Promise<void>;

  releaseStorageReconciliationLock(
    sessionId: SessionID,
    peerId: PeerID,
  ): Promise<void>;
}

export interface DBTransactionInterfaceSync {
  getSingleCoValueSession(
    coValueRowId: number,
    sessionID: SessionID,
  ): StoredSessionRow | undefined;

  /**
   * Persist a "deleted coValue" marker in storage (work queue entry).
   * This is an enqueue signal: implementations should set status to `"pending"`.
   * This is expected to be idempotent (safe to call repeatedly).
   */
  markCoValueAsDeleted(id: RawCoID): unknown;

  addSessionUpdate({
    sessionUpdate,
    sessionRow,
  }: {
    sessionUpdate: SessionRow;
    sessionRow?: StoredSessionRow;
  }): number;

  addTransaction(
    sessionRowID: number,
    idx: number,
    newTransaction: Transaction,
  ): number | undefined | unknown;

  addSignatureAfter({
    sessionRowID,
    idx,
    signature,
  }: {
    sessionRowID: number;
    idx: number;
    signature: Signature;
  }): number | undefined | unknown;

  getStorageReconciliationLock(
    key: string,
  ): StorageReconciliationLockRow | undefined;

  putStorageReconciliationLock(entry: StorageReconciliationLockRow): void;
}

export interface DBClientInterfaceSync {
  getCoValue(coValueId: string): StoredCoValueRow | undefined;

  upsertCoValue(id: string, header?: CoValueHeader): number | undefined;

  /**
   * Enumerate all coValue IDs currently pending in the "deleted coValues" work queue.
   */
  getAllCoValuesWaitingForDelete(): RawCoID[];

  getCoValueSessions(coValueRowId: number): StoredSessionRow[];

  getNewTransactionInSession(
    sessionRowId: number,
    fromIdx: number,
    toIdx: number,
  ): TransactionRow[];

  getSignatures(
    sessionRowId: number,
    firstNewTxIdx: number,
  ): Pick<SignatureAfterRow, "idx" | "signature">[];

  transaction(callback: (tx: DBTransactionInterfaceSync) => unknown): unknown;

  trackCoValuesSyncState(
    updates: { id: RawCoID; peerId: PeerID; synced: boolean }[],
  ): void;

  getUnsyncedCoValueIDs(): RawCoID[];

  stopTrackingSyncState(id: RawCoID): void;

  /**
   * Physical deletion primitive: erase all persisted history for a deleted coValue,
   * while preserving the tombstone (header + delete session(s)).
   * Must run inside a single storage transaction.
   */
  eraseCoValueButKeepTombstone(coValueID: RawCoID): unknown;

  deleteSessionContent(coValueRowId: number, sessionID: SessionID): void;

  /**
   * Get the knownState for a CoValue without loading transactions.
   * Returns undefined if the CoValue doesn't exist.
   */
  getCoValueKnownState(coValueId: string): CoValueKnownState | undefined;

  getCoValueIDs(limit: number, offset: number): { id: RawCoID }[];

  getCoValueCount(): number;

  tryAcquireStorageReconciliationLock(
    sessionId: SessionID,
    peerId: PeerID,
  ): StorageReconciliationAcquireResult;

  renewStorageReconciliationLock(
    sessionId: SessionID,
    peerId: PeerID,
    offset: number,
  ): void;

  releaseStorageReconciliationLock(sessionId: SessionID, peerId: PeerID): void;
}
