import { base58 } from "@scure/base";
import { md5 } from "@noble/hashes/legacy";
import { Histogram, ValueType, metrics } from "@opentelemetry/api";
import { PeerState } from "./PeerState.js";
import { SyncStateManager } from "./SyncStateManager.js";
import { UnsyncedCoValuesTracker } from "./UnsyncedCoValuesTracker.js";
import {
  STORAGE_RECONCILIATION_CONFIG,
  SYNC_SCHEDULER_CONFIG,
} from "./config.js";
import {
  getContenDebugInfo,
  getNewTransactionsFromContentMessage,
  getSessionEntriesFromContentMessage,
  getTransactionSize,
  knownStateFromContent,
} from "./coValueContentMessage.js";
import { CoValueCore } from "./coValueCore/coValueCore.js";
import { CoValueHeader, Transaction } from "./coValueCore/verifiedState.js";
import { Signature } from "./crypto/crypto.js";
import { isDeleteSessionID, RawCoID, SessionID, isRawCoID } from "./ids.js";
import { LocalNode } from "./localNode.js";
import { logger } from "./logger.js";
import { CoValuePriority } from "./priority.js";
import { IncomingMessagesQueue } from "./queue/IncomingMessagesQueue.js";
import { LocalTransactionsSyncQueue } from "./queue/LocalTransactionsSyncQueue.js";
import type { StorageStreamingQueue } from "./queue/StorageStreamingQueue.js";
import { OngoingStorageReconciliationTracker } from "./OngoingStorageReconciliationTracker.js";
import { StorageReconciliationServerAckTracker } from "./StorageReconciliationAckTracker.js";
import {
  CoValueKnownState,
  knownStateFrom,
  KnownStateSessions,
  peerHasAllContent,
} from "./knownState.js";
import { StorageAPI } from "./storage/index.js";
import { recoverSignatureMismatch } from "./recovery/index.js";

export type SyncMessage =
  | LoadMessage
  | KnownStateMessage
  | NewContentMessage
  | DoneMessage
  | ReconcileMessage
  | ReconcileAckMessage
  | SignatureMismatchErrorMessage;

export type LoadMessage = {
  action: "load";
} & CoValueKnownState;

export type KnownStateMessage = {
  action: "known";
  isCorrection?: boolean;
  asDependencyOf?: RawCoID;
} & CoValueKnownState;

export type NewContentMessage = {
  action: "content";
  id: RawCoID;
  header?: CoValueHeader;
  priority: CoValuePriority;
  new: {
    [sessionID: SessionID]: SessionNewContent;
  };
  expectContentUntil?: KnownStateSessions;
};

export type SessionNewContent = {
  // The index where to start appending the new transactions. The index counting starts from 1.
  after: number;
  newTransactions: Transaction[];
  lastSignature: Signature;
};

export type DoneMessage = {
  action: "done";
  id: RawCoID;
};

export type ReconcileBatchID = string;

export type ReconcileMessage = {
  action: "reconcile";
  id: ReconcileBatchID;
  values: [coValue: RawCoID, sessionsHash: string][];
};

export type ReconcileAckMessage = {
  action: "reconcile-ack";
  id: ReconcileBatchID;
};

export type SignatureMismatchErrorMessage = {
  action: "error";
  errorType: "SignatureMismatch";
  id: RawCoID;
  sessionID: SessionID;
  content: SessionNewContent[];
};

/**
 * Determines when network sync is enabled.
 * - "always": sync is enabled for both Anonymous Authentication and Authenticated Account
 * - "signedUp": sync is enabled when the user is authenticated
 * - "never": sync is disabled, content stays local
 * Can be dynamically modified to control sync behavior at runtime.
 */
export type SyncWhen = "always" | "signedUp" | "never";

export type PeerID = string;

export type DisconnectedError = "Disconnected";

export interface IncomingPeerChannel {
  close: () => void;
  onMessage: (callback: (msg: SyncMessage | DisconnectedError) => void) => void;
  onClose: (callback: () => void) => void;
}

export interface OutgoingPeerChannel {
  push: (msg: SyncMessage | DisconnectedError) => void;
  close: () => void;
  onClose: (callback: () => void) => void;
}

export interface Peer {
  id: PeerID;
  incoming: IncomingPeerChannel;
  outgoing: OutgoingPeerChannel;
  role: "server" | "client";
  priority?: number;
  persistent?: boolean;
}

function isPersistentServerPeer(peer: Peer | PeerState): boolean {
  return peer.role === "server" && (peer.persistent ?? false);
}

export type ServerPeerSelector = (
  id: RawCoID,
  serverPeers: PeerState[],
) => PeerState[];

/**
 * Manages the sync of coValues between peers.
 * It is responsible for sending, receiving and processing sync messages.
 * For more details on how the sync protocol works, see the sync protocol documentation:
 * {@link docs/sync-protocol.md}
 */
export class SyncManager {
  peers: { [key: PeerID]: PeerState } = {};
  local: LocalNode;
  /**
   * Tracks pending reconcile acks from the server.
   */
  private reconciliationAckTracker =
    new StorageReconciliationServerAckTracker();
  /**
   * Tracks ongoing storage reconciliation batches in a server.
   */
  private ongoingStorageReconciliationTracker =
    new OngoingStorageReconciliationTracker();

  get pendingReconciliationAck(): Map<string, number> {
    return this.reconciliationAckTracker.pendingReconciliationAck;
  }

  // When true, transactions will not be verified.
  // This is useful when syncing only for storage purposes, with the expectation that
  // the transactions have already been verified by the [trusted] peer that sent them.
  private skipVerify: boolean = false;

  // When true, coValues that arrive from server peers will be ignored if they had not
  // explicitly been requested via a load message.
  private _ignoreUnknownCoValuesFromServers: boolean = false;
  ignoreUnknownCoValuesFromServers() {
    this._ignoreUnknownCoValuesFromServers = true;
  }

  fullStorageReconciliationEnabled = false;

  peersCounter = metrics.getMeter("cojson").createUpDownCounter("jazz.peers", {
    description: "Amount of connected peers",
    valueType: ValueType.INT,
    unit: "peer",
  });
  private transactionsSizeHistogram: Histogram;

  serverPeerSelector?: ServerPeerSelector;

  constructor(local: LocalNode) {
    this.local = local;
    this.syncState = new SyncStateManager(this);
    this.unsyncedTracker = new UnsyncedCoValuesTracker();

    this.transactionsSizeHistogram = metrics
      .getMeter("cojson")
      .createHistogram("jazz.transactions.size", {
        description: "The size of transactions in a covalue",
        unit: "bytes",
        valueType: ValueType.INT,
      });
  }

  syncState: SyncStateManager;
  unsyncedTracker: UnsyncedCoValuesTracker;

  disableTransactionVerification() {
    this.skipVerify = true;
  }

  getPeers(id: RawCoID): PeerState[] {
    return this.getServerPeers(id).concat(this.getClientPeers());
  }

  getClientPeers(): PeerState[] {
    return Object.values(this.peers).filter((peer) => peer.role === "client");
  }

  getServerPeers(id: RawCoID, excludePeerId?: PeerID): PeerState[] {
    const serverPeers = Object.values(this.peers).filter(
      (peer) => peer.role === "server" && peer.id !== excludePeerId,
    );
    return this.serverPeerSelector
      ? this.serverPeerSelector(id, serverPeers)
      : serverPeers;
  }

  getPersistentServerPeers(id: RawCoID): PeerState[] {
    return this.getServerPeers(id).filter((peer) => peer.persistent);
  }

  handleSyncMessage(msg: SyncMessage, peer: PeerState) {
    if (msg.action === "reconcile") {
      this.handleReconcile(msg, peer);
      return;
    }
    if (msg.action === "reconcile-ack") {
      this.handleReconcileAck(msg, peer);
      return;
    }

    if (msg.action === "error") {
      return this.handleErrorMessage(msg, peer);
    }

    if (!isRawCoID(msg.id)) {
      const errorType = msg.id ? "invalid" : "undefined";
      logger.warn(`Received sync message with ${errorType} id`, {
        msg,
      });
      return;
    }

    // Prevent core shards from storing content that belongs to other shards.
    //
    // This can happen because a covalue "miss" on a core shard will cause a load message to
    // be sent to the original unsharded core. The original core, treating the peer as a client,
    // will respond with the covalue and its dependencies. Those dependencies might not belong
    // to this shard, so they should be ignored.
    //
    // TODO: remove once core has been sharded.
    if (
      peer.role === "server" &&
      this._ignoreUnknownCoValuesFromServers &&
      !this.local.hasCoValue(msg.id)
    ) {
      logger.warn(
        `Ignoring message ${msg.action} on unknown coValue ${msg.id} from peer ${peer.id}`,
      );
      return;
    }

    if (this.local.getCoValue(msg.id).isErroredInPeer(peer.id)) {
      logger.warn(
        `Skipping message ${msg.action} on errored coValue ${msg.id} from peer ${peer.id}`,
      );
      return;
    }

    switch (msg.action) {
      case "load":
        return this.handleLoad(msg, peer);
      case "known":
        if (msg.isCorrection) {
          return this.handleCorrection(msg, peer);
        } else {
          return this.handleKnownState(msg, peer);
        }
      case "content":
        return this.handleNewContent(msg, peer);
      case "done":
        return;
      default:
        throw new Error(
          `Unknown message type ${(msg as { action: "string" }).action}`,
        );
    }
  }

  private handleErrorMessage(
    msg: Extract<SyncMessage, { action: "error" }>,
    peer: PeerState,
  ) {
    if (msg.errorType !== "SignatureMismatch") {
      return;
    }

    if (peer.role !== "server") {
      return;
    }

    recoverSignatureMismatch(this.local, msg);
  }

  sendNewContent(
    id: RawCoID,
    peer: PeerState,
    forceKnownReplyOnNoDelta: boolean = false,
  ) {
    this.#sendNewContent(id, peer, new Set(), forceKnownReplyOnNoDelta);
  }

  #sendNewContent(
    id: RawCoID,
    peer: PeerState,
    seen: Set<RawCoID>,
    forceKnownReplyOnNoDelta: boolean,
  ) {
    if (seen.has(id)) {
      return;
    }

    seen.add(id);

    const coValue = this.local.getCoValue(id);

    if (!coValue.isAvailable()) {
      return;
    }

    const includeDependencies = peer.role !== "server";
    if (includeDependencies) {
      for (const dependency of coValue.getDependedOnCoValues()) {
        this.#sendNewContent(dependency, peer, seen, false);
      }
    }

    const newContentPieces = coValue.newContentSince(
      peer.getOptimisticKnownState(id),
    );

    if (newContentPieces) {
      for (const piece of newContentPieces) {
        this.trySendToPeer(peer, piece);
      }

      peer.combineOptimisticWith(id, coValue.knownState());
    } else if (forceKnownReplyOnNoDelta || !peer.toldKnownState.has(id)) {
      if (coValue.isDeleted) {
        // This way we make the peer believe that we've always ingested all the content they sent, even though we skipped it because the coValue is deleted
        this.trySendToPeer(
          peer,
          coValue.stopSyncingKnownStateMessage(peer.getKnownState(id)),
        );
      } else {
        this.trySendToPeer(peer, {
          action: "known",
          ...coValue.knownStateWithStreaming(),
        });
      }
    }

    peer.trackToldKnownState(id);
  }

  /**
   * Reconciles all in-memory CoValues with all persistent server peers
   */
  reconcileServerPeers() {
    const serverPeers = Object.values(this.peers).filter(
      isPersistentServerPeer,
    );
    for (const peer of serverPeers) {
      this.startPeerReconciliation(peer);
    }
  }

  /**
   * Ensures all CoValues in storage are synced to the given server peer.
   * Sends "reconcile" message(s) with [coValueId, sessionsHash] for each CoValue.
   * Server responds with "known" only where it is missing the CoValue or has different sessions,
   * so that client can send missing content.
   * Processes CoValues in batches of RECONCILIATION_BATCH_SIZE.
   * @param peer - The server peer to reconcile with.
   * @param initialOffset - Offset to start from (for resuming after interrupt). Default 0.
   * @param onComplete - Called when reconciliation is fully complete (all batches sent and acked).
   */
  startStorageReconciliation(
    peer: PeerState,
    initialOffset?: number,
    onComplete?: () => void,
  ): void {
    if (!this.local.storage) return;
    if (!isPersistentServerPeer(peer)) return;

    const startOffset = initialOffset ?? 0;
    const batchSize = STORAGE_RECONCILIATION_CONFIG.BATCH_SIZE;

    const storage = this.local.storage;

    storage.getCoValueCount((totalCoValueCount) => {
      const sendReconcileMessage = (
        batchId: string,
        entries: [RawCoID, string][],
        offset: number,
      ) => {
        if (entries.length === 0) return;

        this.reconciliationAckTracker.trackBatch(
          batchId,
          peer.id,
          offset + batchSize,
        );

        this.trySendToPeer(peer, {
          action: "reconcile",
          id: batchId,
          values: entries,
        });
      };

      const triggerNextBatch = (lastBatchLength: number, offset: number) => {
        // This value becomes false when the last covalueid batch picked from the storage
        // is smaller than the batch size.
        if (lastBatchLength === batchSize) {
          logger.info("Reconciled CoValues in storage", {
            peerId: peer.id,
            completed: offset + batchSize,
            total: totalCoValueCount,
          });
          processStorageBatch(offset + batchSize);
        } else {
          // Note: `completed` can be higher than `total` if CoValues were added
          // after the reconciliation started
          logger.info("Storage reconciliation complete", {
            peerId: peer.id,
            startOffset,
            completed: offset + lastBatchLength,
            total: totalCoValueCount,
          });
          onComplete?.();
        }
      };

      const processStorageBatch = (offset: number) => {
        storage.getCoValueIDs(batchSize, offset, (batch) => {
          this.buildStorageReconciliationEntries(batch, (entries) => {
            if (entries.length === 0) {
              triggerNextBatch(batch.length, offset);
              return;
            }

            const batchId = base58.encode(this.local.crypto.randomBytes(12));
            sendReconcileMessage(batchId, entries, offset);

            this.reconciliationAckTracker.waitForAck(batchId, peer, () => {
              triggerNextBatch(batch.length, offset);
            });
          });
        });
      };

      logger.info("Starting storage reconciliation", {
        peerId: peer.id,
        startOffset,
        total: totalCoValueCount,
      });
      processStorageBatch(startOffset);
    });
  }

  private buildStorageReconciliationEntries(
    batch: { id: RawCoID }[],
    callback: (entries: [RawCoID, string][]) => void,
  ): void {
    const storage = this.local.storage;

    if (!storage) {
      callback([]);
      return;
    }

    const pending = batch.filter(({ id }) => !this.local.isCoValueInMemory(id));

    if (pending.length === 0) {
      callback([]);
      return;
    }

    let done = 0;
    const entries: [RawCoID, string][] = [];

    for (const coValue of pending) {
      storage.loadKnownState(coValue.id, (storageKnownState) => {
        if (storageKnownState) {
          entries.push([
            coValue.id,
            this.hashKnownStateSessions(storageKnownState.sessions),
          ]);
        }

        done += 1;
        if (done === pending.length) {
          callback(entries);
        }
      });
    }
  }

  private maybeStartStorageReconciliationForPeer(peer: PeerState): void {
    if (!this.fullStorageReconciliationEnabled) return;
    if (!this.local.storage) return;

    const sessionId = this.local.currentSessionID;
    this.local.storage.tryAcquireStorageReconciliationLock(
      sessionId,
      peer.id,
      (result) => {
        if (!result.acquired) return;

        const lastProcessedOffset = result.lastProcessedOffset;
        this.startStorageReconciliation(peer, lastProcessedOffset, () => {
          this.local.storage?.releaseStorageReconciliationLock(
            sessionId,
            peer.id,
          );
        });
      },
    );
  }

  async resumeUnsyncedCoValues(): Promise<void> {
    if (!this.local.storage) {
      // No storage available, skip resumption
      return;
    }

    await new Promise<void>((resolve, reject) => {
      // Load all persisted unsynced CoValues from storage
      this.local.storage?.getUnsyncedCoValueIDs((unsyncedCoValueIDs) => {
        const coValuesToLoad = unsyncedCoValueIDs.filter(
          (coValueId) => !this.local.hasCoValue(coValueId),
        );
        if (coValuesToLoad.length === 0) {
          resolve();
          return;
        }

        const BATCH_SIZE = 10;
        let processed = 0;

        const processBatch = async () => {
          const batch = coValuesToLoad.slice(processed, processed + BATCH_SIZE);

          await Promise.all(
            batch.map(
              async (coValueId) =>
                new Promise<void>((resolve) => {
                  try {
                    // Clear previous tracking (as it may include outdated peers)
                    this.local.storage?.stopTrackingSyncState(coValueId);

                    // Resume tracking sync state for this CoValue
                    // This will add it back to the tracker and set up subscriptions
                    this.trackSyncState(coValueId);

                    // Load the CoValue from storage (this will trigger sync if peers are connected)
                    const coValue = this.local.getCoValue(coValueId);
                    coValue.loadFromStorage((found) => {
                      if (!found) {
                        // CoValue could not be loaded from storage, stop tracking
                        this.unsyncedTracker.removeAll(coValueId);
                      }
                      resolve();
                    });
                  } catch (error) {
                    // Handle errors gracefully - log but don't fail the entire resumption
                    logger.warn(
                      `Failed to resume sync for CoValue ${coValueId}:`,
                      {
                        err: error,
                        coValueId,
                      },
                    );
                    this.unsyncedTracker.removeAll(coValueId);
                    resolve();
                  }
                }),
            ),
          );

          processed += batch.length;

          if (processed < coValuesToLoad.length) {
            processBatch().catch(reject);
          } else {
            resolve();
          }
        };

        processBatch().catch(reject);
      });
    });
  }

  /**
   * Reconciles all in-memory CoValues with the given peer.
   * Creates a subscription for each CoValue that is not already subscribed to.
   */
  startPeerReconciliation(peer: PeerState) {
    if (isPersistentServerPeer(peer)) {
      // Resume syncing unsynced CoValues asynchronously
      this.resumeUnsyncedCoValues().catch((error) => {
        logger.warn("Failed to resume unsynced CoValues:", error);
      });

      // Try to run full storage reconciliation for this peer (scheduled per peer, every 30 days)
      this.maybeStartStorageReconciliationForPeer(peer);
    }

    const coValuesOrderedByDependency: CoValueCore[] = [];

    const seen = new Set<string>();
    const buildOrderedCoValueList = (coValue: CoValueCore) => {
      if (seen.has(coValue.id)) {
        return;
      }
      seen.add(coValue.id);

      // Ignore the covalue if this peer isn't relevant to it
      if (
        this.getServerPeers(coValue.id).find((p) => p.id === peer.id) ===
        undefined
      ) {
        return;
      }

      for (const id of coValue.getDependedOnCoValues()) {
        const coValue = this.local.getCoValue(id);

        if (coValue.isAvailable()) {
          buildOrderedCoValueList(coValue);
        }
      }

      coValuesOrderedByDependency.push(coValue);
    };

    for (const coValue of this.local.allCoValues()) {
      if (coValue.isAvailable()) {
        // In memory - build ordered list for dependency-aware sending
        buildOrderedCoValueList(coValue);
      } else if (coValue.loadingState === "unknown") {
        // Skip unknown CoValues - we never tried to load them, so don't
        // restore a subscription we never had. This prevents loading
        // content for CoValues we don't actually care about.
        continue;
      } else if (!peer.loadRequestSent.has(coValue.id)) {
        // For garbageCollected/onlyKnownState: knownState() returns lastKnownState
        // For unavailable/loading/errored: knownState() returns empty state
        peer.sendLoadRequest(coValue, "low-priority");
      }

      // Fill the missing known states with empty known states
      if (!peer.getKnownState(coValue.id)) {
        peer.setKnownState(coValue.id, "empty");
      }
    }

    for (const coValue of coValuesOrderedByDependency) {
      /**
       * We send the load messages to:
       * - Subscribe to the coValue updates
       * - Start the sync process in case we or the other peer
       *   lacks some transactions
       *
       * Use low priority for reconciliation loads so that user-initiated
       * loads take precedence.
       */
      peer.sendLoadRequest(coValue, "low-priority");
    }
  }

  messagesQueue = new IncomingMessagesQueue(() => this.processQueues());
  private processing = false;

  pushMessage(incoming: SyncMessage, peer: PeerState) {
    this.messagesQueue.push(incoming, peer);
  }

  /**
   * Get the storage streaming queue if available.
   * Returns undefined if storage doesn't have a streaming queue.
   */
  private getStorageStreamingQueue(): StorageStreamingQueue | undefined {
    const storage = this.local.storage;
    if (storage && "streamingQueue" in storage) {
      return storage.streamingQueue as StorageStreamingQueue;
    }
    return undefined;
  }

  /**
   * Unified queue processing that coordinates both incoming messages
   * and storage streaming entries.
   *
   * Processes items from both queues with priority ordering:
   * - Incoming messages are processed via round-robin across peers
   * - Storage streaming entries are processed by priority (MEDIUM before LOW)
   *
   * Implements time budget scheduling to avoid blocking the main thread.
   */
  private async processQueues() {
    if (this.processing) {
      return;
    }

    this.processing = true;
    let lastTimer = performance.now();

    const streamingQueue = this.getStorageStreamingQueue();

    while (true) {
      // First, try to pull from incoming messages queue
      const messageEntry = this.messagesQueue.pull();
      if (messageEntry) {
        const start = performance.now();
        try {
          this.handleSyncMessage(messageEntry.msg, messageEntry.peer);
        } catch (err) {
          logger.error("Error processing message", { err });
        } finally {
          this.messagesQueue.recordProcessingTime(
            messageEntry.msg.action,
            performance.now() - start,
          );
        }
      }

      // Then, try to pull from storage streaming queue
      const pushStreamingContent = streamingQueue?.pull();
      if (pushStreamingContent) {
        try {
          // Invoke the pushContent callback to stream the content
          pushStreamingContent();
        } catch (err) {
          logger.error("Error processing storage streaming entry", {
            err,
          });
        }
      }

      // If both queues are empty, we're done
      if (!messageEntry && !pushStreamingContent) {
        break;
      }

      // Check if we have blocked the main thread for too long
      // and if so, yield to the event loop
      const currentTimer = performance.now();
      if (
        currentTimer - lastTimer >
        SYNC_SCHEDULER_CONFIG.INCOMING_MESSAGES_TIME_BUDGET
      ) {
        await waitForNextTick();
        lastTimer = performance.now();
      }
    }

    this.processing = false;
  }

  addPeer(peer: Peer, skipReconciliation: boolean = false) {
    const prevPeer = this.peers[peer.id];

    const peerState = prevPeer
      ? prevPeer.newPeerStateFrom(peer)
      : new PeerState(peer, undefined);

    this.peers[peer.id] = peerState;

    this.peersCounter.add(1, { role: peer.role });

    const unsubscribeFromKnownStatesUpdates =
      peerState.subscribeToKnownStatesUpdates((id, knownState) => {
        this.syncState.triggerUpdate(peer, id, knownState.value());
      });

    if (!skipReconciliation && peerState.role === "server") {
      this.startPeerReconciliation(peerState);
    }

    peerState.incoming.onMessage((msg) => {
      if (msg === "Disconnected") {
        peerState.gracefulShutdown();
        return;
      }

      this.pushMessage(msg, peerState);
    });

    peerState.addCloseListener(() => {
      unsubscribeFromKnownStatesUpdates();
      this.ongoingStorageReconciliationTracker.clearPeer(peer.id);
      this.peersCounter.add(-1, { role: peer.role });

      if (!peer.persistent && this.peers[peer.id] === peerState) {
        this.removePeer(peer.id);
      }
    });
  }

  removePeer(peerId: PeerID) {
    const peer = this.peers[peerId];
    if (!peer) {
      return;
    }
    if (!peer.closed) {
      peer.gracefulShutdown();
    }
    delete this.peers[peer.id];
  }

  trySendToPeer(peer: PeerState, msg: SyncMessage) {
    return peer.pushOutgoingMessage(msg);
  }

  /**
   * Handles the load message from a peer.
   *
   * Differences with the known state message:
   * - The load message triggers the CoValue loading process on the other peer
   * - The peer known state is stored as-is instead of being merged
   * - The load message always replies with a known state message
   */
  handleLoad(msg: LoadMessage, peer: PeerState) {
    /**
     * We use the msg sessions as source of truth for the known states
     *
     * This way we can track part of the data loss that may occur when the other peer is restarted
     *
     */
    peer.setKnownState(msg.id, knownStateFrom(msg));
    const coValue = this.local.getCoValue(msg.id);

    // Fast path: CoValue is already in memory
    if (coValue.isAvailable()) {
      this.sendNewContent(msg.id, peer, true);
      return;
    }

    const peerKnownState = peer.getOptimisticKnownState(msg.id);

    // Fast path: Peer has no content at all - skip lazy load check, just load directly
    if (!peerKnownState?.header) {
      this.loadFromStorageAndRespond(msg.id, peer, coValue);
      return;
    }

    // Check storage knownState before doing full load (lazy load optimization)
    coValue.getKnownStateFromStorage((storageKnownState) => {
      // Race condition: CoValue might have been loaded while we were waiting for storage
      if (coValue.isAvailable()) {
        this.sendNewContent(msg.id, peer, true);
        return;
      }

      if (!storageKnownState) {
        // Not in storage, try loading from peers
        this.loadFromPeersAndRespond(msg.id, peer, coValue);
        return;
      }

      // Check if peer already has all content
      if (peerHasAllContent(storageKnownState, peerKnownState)) {
        // Peer already has everything - reply with known message, no full load needed
        peer.trackToldKnownState(msg.id);
        this.trySendToPeer(peer, {
          action: "known",
          ...storageKnownState,
        });

        // Subscribe to server peers (e.g., core) to receive future updates.
        // Even though we responded with KNOWN (client has everything), we need
        // to establish a subscription so that updates from core flow to us.
        const serverPeers = this.getServerPeers(msg.id, peer.id);
        coValue.loadFromPeers(serverPeers, "low-priority");

        return;
      }

      // Peer needs content - do full load from storage
      this.loadFromStorageAndRespond(msg.id, peer, coValue);
    });
  }

  /**
   * Helper to load from storage and respond appropriately.
   * Falls back to peers if not found in storage.
   */
  private loadFromStorageAndRespond(
    id: RawCoID,
    peer: PeerState,
    coValue: CoValueCore,
  ) {
    coValue.loadFromStorage((found) => {
      if (found && coValue.isAvailable()) {
        this.sendNewContent(id, peer, true);
      } else {
        this.loadFromPeersAndRespond(id, peer, coValue);
      }
    });
  }

  /**
   * Helper to load from peers and respond appropriately.
   */
  private loadFromPeersAndRespond(
    id: RawCoID,
    peer: PeerState,
    coValue: CoValueCore,
  ) {
    const peers = this.getServerPeers(id, peer.id);
    coValue.loadFromPeers(peers, "immediate");

    const handleLoadResult = () => {
      if (coValue.isAvailable()) {
        this.sendNewContent(id, peer);
        return;
      }
      this.handleLoadNotFound(id, peer);
    };

    if (peers.length > 0) {
      coValue.waitForAvailableOrUnavailable().then(handleLoadResult);
    } else {
      handleLoadResult();
    }
  }

  /**
   * Handle case when CoValue is not found.
   */
  private handleLoadNotFound(id: RawCoID, peer: PeerState) {
    peer.trackToldKnownState(id);
    this.trySendToPeer(peer, {
      action: "known",
      id,
      header: false,
      sessions: {},
    });
  }

  /**
   * Request full content from a peer when we don't have the CoValue.
   */
  private requestFullContent(id: RawCoID, peer: PeerState | undefined) {
    if (peer) {
      this.trySendToPeer(peer, {
        action: "known",
        isCorrection: true,
        id,
        header: false,
        sessions: {},
      });
    } else {
      // The wrong assumption has been made by storage or import, we don't have a recovery mechanism
      // Should never happen
      logger.error("Received new content with no header on a missing CoValue", {
        id,
      });
    }
  }

  handleKnownState(msg: KnownStateMessage, peer: PeerState) {
    const coValue = this.local.getCoValue(msg.id);

    peer.combineWith(msg.id, knownStateFrom(msg));

    // The header is a boolean value that tells us if the other peer has information about the header.
    // If it's false at this point it means that the coValue is unavailable on the other peer.
    const availableOnPeer = peer.getOptimisticKnownState(msg.id)?.header;

    if (!availableOnPeer) {
      coValue.markNotFoundInPeer(peer.id);
    }

    if (coValue.isAvailable()) {
      this.sendNewContent(msg.id, peer);
    } else if (coValue.isKnownStateAvailable()) {
      // Validate if content is missing before loading it from storage
      if (!this.syncState.isSynced(peer, msg.id)) {
        this.local.loadCoValueCore(msg.id).then(() => {
          this.sendNewContent(msg.id, peer);
        });
      }
    }

    peer.trackLoadRequestComplete(coValue, "known");
    this.maybeMarkCoValueAsReconciled(peer, msg.id);
  }

  handleReconcile(msg: ReconcileMessage, peer: PeerState): void {
    let remaining = msg.values.length;
    if (remaining === 0) {
      this.trySendToPeer(peer, { action: "reconcile-ack", id: msg.id });
      return;
    }

    const pending = new Set<RawCoID>();
    const processEntryDone = () => {
      remaining -= 1;

      if (remaining !== 0) {
        return;
      }

      if (pending.size === 0) {
        this.trySendToPeer(peer, { action: "reconcile-ack", id: msg.id });
        return;
      }

      this.ongoingStorageReconciliationTracker.trackBatch(
        peer.id,
        msg.id,
        pending,
      );
    };

    for (const [coValueId, clientSessionsHash] of msg.values) {
      // Avoid creating a new coValue object if it's not already in memory
      const inMemoryCoValue = this.local.isCoValueInMemory(coValueId)
        ? this.local.getCoValue(coValueId)
        : undefined;
      if (inMemoryCoValue?.isErroredInPeer(peer.id)) {
        processEntryDone();
        continue;
      }

      const maybeSendLoadRequest = (
        knownState: CoValueKnownState | undefined,
      ) => {
        if (!knownState) {
          pending.add(coValueId);
          peer.trackToldKnownState(coValueId);
          this.trySendToPeer(peer, {
            action: "load",
            id: coValueId,
            header: false,
            sessions: {},
          });
        } else {
          const serverSessionsHash = this.hashKnownStateSessions(
            knownState.sessions,
          );
          if (serverSessionsHash !== clientSessionsHash) {
            pending.add(coValueId);
            peer.trackToldKnownState(coValueId);
            this.trySendToPeer(peer, { action: "load", ...knownState });
          }
        }
        processEntryDone();
      };

      if (
        inMemoryCoValue?.isAvailable() ||
        inMemoryCoValue?.loadingState === "onlyKnownState"
      ) {
        maybeSendLoadRequest(inMemoryCoValue.knownState());
      } else {
        this.local.storage
          ? this.local.storage.loadKnownState(coValueId, maybeSendLoadRequest)
          : maybeSendLoadRequest(undefined);
      }
    }
  }

  handleReconcileAck(msg: ReconcileAckMessage, peer: PeerState): void {
    const nextOffset = this.reconciliationAckTracker.handleAck(msg.id, peer.id);
    if (nextOffset !== undefined) {
      this.local.storage?.renewStorageReconciliationLock(
        this.local.currentSessionID,
        peer.id,
        nextOffset,
      );
    }
  }

  private hashKnownStateSessions(sessions: KnownStateSessions): string {
    return this.local.crypto.shortHash(sessions);
  }

  recordTransactionsSize(newTransactions: Transaction[], source: string) {
    for (const tx of newTransactions) {
      const size = getTransactionSize(tx);

      this.transactionsSizeHistogram.record(size, {
        source,
      });
    }
  }

  handleNewContent(
    msg: NewContentMessage,
    from: PeerState | "storage" | "import",
  ) {
    const coValue = this.local.getCoValue(msg.id);
    const peer = from === "storage" || from === "import" ? undefined : from;

    const sourceRole =
      from === "storage"
        ? "storage"
        : from === "import"
          ? "import"
          : peer?.role;

    // TODO: We can't handle client-to-client streaming until we
    // handle the streaming state reset on disconnection
    if (peer?.role === "client" && msg.expectContentUntil) {
      msg = {
        ...msg,
        expectContentUntil: undefined,
      };
    }

    peer?.trackLoadRequestUpdate(coValue);
    coValue.addDependenciesFromContentMessage(msg);

    // If some of the dependencies are missing, we wait for them to be available
    // before handling the new content
    // This must happen even if the dependencies are not related to this content
    // but the content we've got before
    if (!this.skipVerify && coValue.hasMissingDependencies()) {
      coValue.addNewContentToQueue(msg, from);

      for (const dependency of coValue.missingDependencies) {
        const dependencyCoValue = this.local.getCoValue(dependency);
        if (!dependencyCoValue.hasVerifiedContent()) {
          const peers = this.getServerPeers(dependency);

          // If the peer that sent the new content is a client, we can assume that they are in possession of the dependency
          if (peer?.role === "client") {
            peers.push(peer);
          }

          // Use immediate mode to bypass the concurrency limit for dependencies
          // We do this to avoid that the dependency load is blocked
          // by the pending dependendant load
          // Also these should be done with the highest priority, because we need to
          // unblock the coValue wait
          dependencyCoValue.load(peers, "immediate");
        }
      }

      return;
    }

    /**
     * Check if we have the CoValue in memory
     */
    if (!coValue.hasVerifiedContent()) {
      /**
       * The peer/import has assumed we already have the CoValue
       */
      if (!msg.header) {
        // Content from storage without header - this can happen if:
        // 1. Storage is streaming a large CoValue in chunks
        // 2. Server is under heavy load, so a chunk isn't processed for a long time
        // 3. GC cleanup unmounts the CoValue while streaming is in progress
        // 4. The chunk is finally processed, but the CoValue is no longer available
        // TODO: Fix this by either not unmounting CoValues with active streaming,
        // or by cleaning up the streaming queue on unmount
        if (from === "storage") {
          logger.warn(
            "Received content from storage without header - CoValue may have been garbage collected mid-stream",
            {
              id: msg.id,
              from,
            },
          );
          return;
        }

        // Try to load from storage - the CoValue might have been garbage collected from memory
        coValue.loadFromStorage((found) => {
          if (found) {
            // CoValue was in storage, process the new content
            this.handleNewContent(msg, from);
          } else {
            // CoValue not in storage, ask peer for full content
            this.requestFullContent(msg.id, peer);
          }
        });
        return;
      }

      const previousState = coValue.loadingState;

      /**
       * We are getting the full CoValue, so we can instantiate it
       */
      const success = coValue.provideHeader(
        msg.header,
        msg.expectContentUntil,
        this.skipVerify,
      );

      if (!success) {
        logger.error("Failed to provide header", {
          id: msg.id,
          header: msg.header,
        });
        return;
      }

      coValue.markFoundInPeer(peer?.id ?? "storage", previousState);
      peer?.updateHeader(msg.id, true);

      if (msg.expectContentUntil) {
        peer?.combineWith(msg.id, {
          id: msg.id,
          header: true,
          sessions: msg.expectContentUntil,
        });
      }
    } else if (msg.expectContentUntil) {
      coValue.verified.setStreamingKnownState(msg.expectContentUntil);
    }

    // At this point the CoValue must be in memory, if not we have a bug
    if (!coValue.hasVerifiedContent()) {
      throw new Error(
        "Unreachable: CoValue should always have a verified state at this point",
      );
    }

    let invalidStateAssumed = false;

    const validNewContent: NewContentMessage = {
      action: "content",
      id: msg.id,
      priority: msg.priority,
      header: msg.header,
      new: {},
    };

    let wasAlreadyDeleted = coValue.isDeleted;

    const knownState = coValue.knownState();

    /**
     * The coValue is in memory, load the transactions from the content message
     */
    for (const [
      sessionID,
      newContentForSession,
    ] of getSessionEntriesFromContentMessage(msg)) {
      if (wasAlreadyDeleted && !isDeleteSessionID(sessionID)) {
        continue;
      }

      const newTransactions = getNewTransactionsFromContentMessage(
        newContentForSession,
        knownState,
        sessionID,
      );

      if (newTransactions === undefined) {
        invalidStateAssumed = true;
        continue;
      }

      if (newTransactions.length === 0) {
        continue;
      }

      // TODO: Handle invalid signatures in the middle of streaming
      // This could cause a situation where we are unable to load a chunk, and ask for a correction for all the subsequent chunks
      const error = coValue.tryAddTransactions(
        sessionID,
        newTransactions,
        newContentForSession.lastSignature,
        this.skipVerify,
      );

      if (error) {
        if (
          peer?.role === "client" &&
          error.type === "InvalidSignature" &&
          peer.shouldSendSignatureMismatch(msg.id, sessionID)
        ) {
          this.trySendToPeer(peer, {
            action: "error",
            errorType: "SignatureMismatch",
            id: msg.id,
            sessionID,
            content: coValue.verified.getFullSessionContent(sessionID),
          });
          continue; // Continue processing remaining sessions
        }

        if (peer?.role === "client" && error.type === "InvalidSignature") {
          continue;
        }

        if (peer) {
          logger.error("Failed to add transactions", {
            peerId: peer.id,
            peerRole: peer.role,
            id: msg.id,
            errorType: error.type,
            err: error.error,
            sessionID,
            msgKnownState: knownStateFromContent(msg).sessions,
            msgSummary: getContenDebugInfo(msg),
            knownState: coValue.knownState().sessions,
          });
          // TODO Mark only the session as errored, not the whole coValue
          coValue.markErrored(peer.id, error);
        } else {
          logger.error("Failed to add transactions from storage", {
            id: msg.id,
            err: error.error,
            sessionID,
            errorType: error.type,
          });
        }
        continue;
      }

      if (sourceRole && sourceRole !== "import") {
        this.recordTransactionsSize(newTransactions, sourceRole);
      }

      // We reset the new content for the deleted coValue
      // because we want to store only the delete session/transaction
      if (!wasAlreadyDeleted && coValue.isDeleted) {
        wasAlreadyDeleted = true;
        validNewContent.new = {};
      }

      // The new content for this session has been verified, so we can store it
      validNewContent.new[sessionID] = newContentForSession;
    }

    if (peer) {
      if (coValue.isDeleted) {
        // In case of deleted coValues, we combine the known state with the content message
        // to avoid that clients that don't support deleted coValues try to sync their own content indefinitely
        peer.combineWith(msg.id, knownStateFromContent(msg));
      } else {
        peer.combineWith(msg.id, knownStateFromContent(validNewContent));
      }
    }

    /**
     * Check if we lack some transactions to be able to load the new content
     */
    if (invalidStateAssumed) {
      if (peer) {
        this.trySendToPeer(peer, {
          action: "known",
          isCorrection: true,
          ...coValue.knownState(),
        });
        peer.trackToldKnownState(msg.id);
      } else {
        logger.error(
          "Invalid state assumed when handling new content from storage",
          {
            id: msg.id,
            content: getContenDebugInfo(msg),
            knownState: coValue.knownState(),
          },
        );
      }
    } else if (peer) {
      /**
       * We are sending a known state message to the peer to acknowledge the
       * receipt of the new content.
       *
       * This way the sender knows that the content has been received and applied
       * and can update their peer's knownState accordingly.
       */
      if (coValue.isDeleted) {
        // This way we make the peer believe that we've ingested all the content, even though we skipped it because the coValue is deleted
        this.trySendToPeer(
          peer,
          coValue.stopSyncingKnownStateMessage(peer.getKnownState(msg.id)),
        );
      } else {
        this.trySendToPeer(peer, {
          action: "known",
          ...coValue.knownState(),
        });
      }
      peer.trackToldKnownState(msg.id);
    }

    /**
     * Store the content and propagate it to the server peers and the subscribed client peers
     */
    const hasNewContent =
      validNewContent.header || Object.keys(validNewContent.new).length > 0;

    if (from !== "storage" && hasNewContent) {
      this.storeContent(validNewContent);
      if (from === "import") {
        this.trackSyncState(coValue.id);
      }
    }

    peer?.trackLoadRequestComplete(coValue, "content");
    if (peer && !coValue.isStreaming()) {
      this.maybeMarkCoValueAsReconciled(peer, msg.id);
    }

    for (const peer of this.getPeers(coValue.id)) {
      /**
       * We sync the content against the source peer if it is a client or server peers
       * to upload any content that is available on the current node and not on the source peer.
       */
      if (peer.closed || coValue.isErroredInPeer(peer.id)) {
        peer.emitCoValueChange(coValue.id);
        continue;
      }

      // We directly forward the new content to peers that have an active subscription
      if (peer.isCoValueSubscribedToPeer(coValue.id)) {
        this.sendNewContent(coValue.id, peer);
      } else if (peer.role === "server") {
        peer.sendLoadRequest(coValue, "low-priority");
      }
    }
  }

  handleCorrection(msg: KnownStateMessage, peer: PeerState) {
    peer.setKnownState(msg.id, knownStateFrom(msg));

    return this.sendNewContent(msg.id, peer);
  }

  private maybeMarkCoValueAsReconciled(peer: PeerState, coValueId: RawCoID) {
    const completedBatchIds =
      this.ongoingStorageReconciliationTracker.markItemComplete(
        peer.id,
        coValueId,
      );
    for (const batchId of completedBatchIds) {
      this.trySendToPeer(peer, {
        action: "reconcile-ack",
        id: batchId,
      });
    }
  }

  private syncQueue = new LocalTransactionsSyncQueue((content) =>
    this.syncContent(content),
  );
  syncLocalTransaction = this.syncQueue.syncTransaction;
  trackDirtyCoValues = this.syncQueue.trackDirtyCoValues;

  syncContent(content: NewContentMessage) {
    const coValue = this.local.getCoValue(content.id);

    this.storeContent(content);

    this.trackSyncState(coValue.id);

    const contentKnownState = knownStateFromContent(content);

    for (const peer of this.getPeers(coValue.id)) {
      // Only subscribed CoValues are synced to clients
      if (
        peer.role === "client" &&
        !peer.isCoValueSubscribedToPeer(coValue.id)
      ) {
        continue;
      }

      if (peer.closed || coValue.isErroredInPeer(peer.id)) {
        peer.emitCoValueChange(content.id);
        continue;
      }

      // We assume that the peer already knows anything before this content
      // Any eventual reconciliation will be handled through the known state messages exchange
      this.trySendToPeer(peer, content);
      peer.combineOptimisticWith(coValue.id, contentKnownState);
      peer.trackToldKnownState(coValue.id);
    }
  }

  private trackSyncState(coValueId: RawCoID): void {
    const peers = this.getPersistentServerPeers(coValueId);

    const isSyncRequired = this.local.syncWhen !== "never";
    if (isSyncRequired && peers.length === 0) {
      this.unsyncedTracker.add(coValueId);

      // Mark CoValue as synced once a persistent server peer is added and
      // the CoValue is synced
      const unsubscribe = this.syncState.subscribeToCoValueUpdates(
        coValueId,
        (peer, _knownState, syncState) => {
          if (isPersistentServerPeer(peer) && syncState.uploaded) {
            this.unsyncedTracker.remove(coValueId);
            unsubscribe();
          }
        },
      );
      return;
    }

    for (const peer of peers) {
      if (this.syncState.isSynced(peer, coValueId)) {
        continue;
      }
      const alreadyTracked = this.unsyncedTracker.add(coValueId, peer.id);
      if (alreadyTracked) {
        continue;
      }

      const unsubscribe = this.syncState.subscribeToPeerUpdates(
        peer.id,
        coValueId,
        (_knownState, syncState) => {
          if (syncState.uploaded) {
            this.unsyncedTracker.remove(coValueId, peer.id);
            unsubscribe();
          }
        },
      );
    }
  }

  private storeContent(content: NewContentMessage) {
    const storage = this.local.storage;

    if (!storage) return;

    const value = this.local.getCoValue(content.id);

    if (value.isDeleted) {
      // This doesn't persist the delete flag, it only signals the storage
      // API that the delete transaction is valid
      storage.markDeleteAsValid(value.id);
    }

    // Try to store the content as-is for performance
    // In case that some transactions are missing, a correction will be requested, but it's an edge case
    storage.store(content, (correction) => {
      if (!value.verified) {
        logger.error(
          "Correction requested for a CoValue with no verified content",
          {
            id: content.id,
            content: getContenDebugInfo(content),
            correction,
            state: value.loadingState,
          },
        );
        return undefined;
      }

      return value.newContentSince(correction);
    });
  }

  /**
   * Returns true if the local CoValue changes have been synced to all persistent server peers.
   *
   * Used during garbage collection to determine if the coValue is pending sync.
   */
  isSyncedToServerPeers(id: RawCoID): boolean {
    // If there are currently no server peers, go ahead with GC.
    // The CoValue will be reloaded into memory and synced when a peer is added.
    return this.getPersistentServerPeers(id).every((peer) =>
      this.syncState.isSynced(peer, id),
    );
  }

  waitForSyncWithPeer(peerId: PeerID, id: RawCoID, timeout: number) {
    const peerState = this.peers[peerId];

    // The peer has been closed and is not persistent, so it isn't possible to sync
    if (!peerState) {
      return;
    }

    if (peerState.isCoValueSubscribedToPeer(id)) {
      const isAlreadySynced = this.syncState.isSynced(peerState, id);

      if (isAlreadySynced) {
        return;
      }
    } else if (peerState.role === "client") {
      // The client isn't subscribed to the coValue, so we won't sync it
      return;
    }

    return new Promise((resolve, reject) => {
      const unsubscribe = this.syncState.subscribeToPeerUpdates(
        peerId,
        id,
        (_knownState, syncState) => {
          if (syncState.uploaded) {
            resolve(true);
            unsubscribe?.();
            clearTimeout(timeoutId);
          }
        },
      );

      const timeoutId = setTimeout(() => {
        const coValue = this.local.getCoValue(id);
        const erroredInPeer = coValue.getErroredInPeerError(peerId);
        const knownState = coValue.knownState().sessions;
        const peerKnownState = peerState.getKnownState(id)?.sessions ?? {};
        let errorMessage = `Timeout on waiting for sync with peer ${peerId} for coValue ${id}:
  Known state: ${JSON.stringify(knownState)}
  Peer state: ${JSON.stringify(peerKnownState)}
`;

        if (erroredInPeer) {
          errorMessage += `\nMarked as errored: "${erroredInPeer}"`;
        }

        reject(new Error(errorMessage));
        unsubscribe?.();
      }, timeout);
    });
  }

  waitForStorageSync(id: RawCoID) {
    return this.local.storage?.waitForSync(id, this.local.getCoValue(id));
  }

  waitForSync(id: RawCoID, timeout = 60_000) {
    const peers = this.getPeers(id);

    return Promise.all(
      peers
        .map((peer) => this.waitForSyncWithPeer(peer.id, id, timeout))
        .concat(this.waitForStorageSync(id)),
    );
  }

  waitForAllCoValuesSync(timeout = 60_000) {
    const coValues = this.local.allCoValues();
    const validCoValues = Array.from(coValues).filter(
      (coValue) =>
        coValue.loadingState === "available" ||
        coValue.loadingState === "loading",
    );

    return Promise.all(
      validCoValues.map((coValue) => this.waitForSync(coValue.id, timeout)),
    );
  }

  setStorage(storage: StorageAPI) {
    this.unsyncedTracker.setStorage(storage);

    const storageStreamingQueue = this.getStorageStreamingQueue();
    if (storageStreamingQueue) {
      storageStreamingQueue.setListener(() => {
        this.processQueues();
      });
    }
  }

  removeStorage() {
    this.unsyncedTracker.removeStorage();
  }

  /**
   * Closes all the peer connections and ensures the list of unsynced coValues is persisted to storage.
   * @returns Promise of the current pending store operation, if any.
   */
  gracefulShutdown(): Promise<void> | undefined {
    for (const peer of Object.values(this.peers)) {
      peer.gracefulShutdown();
    }
    return this.unsyncedTracker.forcePersist();
  }
}

/**
 * Returns a ServerPeerSelector that implements the Highest Weighted Random (HWR) algorithm.
 *
 * The HWR algorithm deterministically selects the top `n` peers for a given CoValue ID by assigning
 * each peer a "weight" based on the MD5 hash of the concatenation of the CoValue ID and the peer's ID.
 * The first 4 bytes of the hash are interpreted as a 32-bit unsigned integer, which serves as the peer's weight.
 * Peers are then sorted in descending order of weight, and the top `n` are selected.
 */
export function hwrServerPeerSelector(n: number): ServerPeerSelector {
  if (n === 0) {
    throw new Error("n must be greater than 0");
  }

  const enc = new TextEncoder();

  // Take the md5 hash of the peer ID and CoValue ID and convert the first 4 bytes to a 32-bit unsigned integer
  const getWeight = (id: RawCoID, peer: PeerState): number => {
    const hash = md5(enc.encode(id + peer.id));
    return (
      ((hash[0]! << 24) | (hash[1]! << 16) | (hash[2]! << 8) | hash[3]!) >>> 0
    );
  };

  return (id, serverPeers) => {
    if (serverPeers.length <= n) {
      return serverPeers;
    }

    const weightedPeers = serverPeers.map((peer) => {
      return {
        peer,
        weight: getWeight(id, peer),
      };
    });

    return weightedPeers
      .sort((a, b) => b.weight - a.weight)
      .slice(0, n)
      .map((wp) => wp.peer);
  };
}

let waitForNextTick = () =>
  new Promise<void>((resolve) => queueMicrotask(resolve));

if (typeof setImmediate === "function") {
  waitForNextTick = () => new Promise<void>((resolve) => setImmediate(resolve));
}
