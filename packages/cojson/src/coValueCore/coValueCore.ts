import { UpDownCounter, ValueType, metrics } from "@opentelemetry/api";
import type { PeerState } from "../PeerState.js";
import type { RawCoValue } from "../coValue.js";
import type { LoadMode } from "../queue/OutgoingLoadQueue.js";
import { type ControlledAccountOrAgent } from "../coValues/account.js";
import type { RawGroup } from "../coValues/group.js";
import { CO_VALUE_LOADING_CONFIG } from "../config.js";
import { coreToCoValue } from "../coreToCoValue.js";
import {
  CryptoProvider,
  Hash,
  KeyID,
  KeySecret,
  Signature,
  SignerID,
} from "../crypto/crypto.js";
import {
  ActiveSessionID,
  AgentID,
  isDeleteSessionID,
  RawCoID,
  SessionID,
  TransactionID,
  toConflictSessionID,
} from "../ids.js";
import { JsonObject, JsonValue } from "../jsonValue.js";
import { LocalNode, ResolveAccountAgentError } from "../localNode.js";
import { logger } from "../logger.js";
import { determineValidTransactions } from "../permissions.js";
import {
  KnownStateMessage,
  NewContentMessage,
  PeerID,
  SessionNewContent,
} from "../sync.js";
import { accountOrAgentIDfromSessionID } from "../typeUtils/accountOrAgentIDfromSessionID.js";
import { expectGroup } from "../typeUtils/expectGroup.js";
import {
  getDependenciesFromContentMessage,
  getDependenciesFromGroupRawTransactions,
  getDependenciesFromHeader,
} from "./utils.js";
import { CoValueHeader, Transaction, VerifiedState } from "./verifiedState.js";
import {
  MergeCommit,
  BranchPointerCommit,
  MergedTransactionMetadata,
  createBranch,
  getBranchId,
  getBranchOwnerId,
  getBranchSource,
  mergeBranch,
  BranchStartCommit,
} from "./branching.js";
import { type RawAccountID } from "../coValues/account.js";
import { decryptTransactionChangesAndMeta } from "./decryptTransactionChangesAndMeta.js";
import {
  cloneKnownState,
  combineKnownStateSessions,
  CoValueFrontier,
  CoValueKnownState,
  emptyKnownState,
  KnownStateSessions,
} from "../knownState.js";
import { safeParseJSON } from "../jsonStringify.js";

export function idforHeader(
  header: CoValueHeader,
  crypto: CryptoProvider,
): RawCoID {
  const hash = crypto.shortHash(header);
  return `co_z${hash.slice("shortHash_z".length)}`;
}

let logPermissionErrors = false;

export function enablePermissionErrors() {
  logPermissionErrors = true;
}

export class VerifiedTransaction {
  // The ID of the CoValue that the transaction belongs to
  coValueId: RawCoID;
  dispatchTransaction: (transaction: VerifiedTransaction) => void;
  // The account or agent that made the transaction
  author: RawAccountID | AgentID;
  // An object containing the session ID and the transaction index
  currentTxID: TransactionID;
  // If this is a merged transaction, the TxID of the transaction inside the original branch
  sourceTxID: TransactionID | undefined;
  tx: Transaction;
  // The Unix time when the transaction was made
  currentMadeAt: number;
  // If this is a merged transaction, the madeAt of the transaction inside the original branch
  sourceTxMadeAt: number | undefined;
  // The decoded changes of the transaction
  changes: JsonValue[] | undefined;
  // The decoded meta information of the transaction
  meta: JsonObject | undefined;
  // Whether the transaction is valid, as per membership rules
  isValid: boolean = false;
  // The error message that caused the transaction to be invalid
  validationErrorMessage: string | undefined = undefined;
  // The previous verified transaction for the same session
  previous: VerifiedTransaction | undefined;
  // Transaction processing stage:
  // - "to-validate": Transaction is pending validation on permissions checks
  // - "validated": Transaction has been validated but not yet applied to content
  // - "processed": Transaction has been validated and applied to content
  stage: "to-validate" | "validated" | "processed" = "to-validate";

  constructor(
    coValueId: RawCoID,
    sessionID: SessionID,
    txIndex: number,
    tx: Transaction,
    branchId: RawCoID | undefined,
    parsingCache:
      | { changes: JsonValue[]; meta: JsonObject | undefined }
      | undefined,
    previous: VerifiedTransaction | undefined,
    dispatchTransaction: (transaction: VerifiedTransaction) => void,
  ) {
    this.dispatchTransaction = dispatchTransaction;
    this.author = accountOrAgentIDfromSessionID(sessionID);

    const txID = branchId
      ? {
          sessionID,
          txIndex,
          branch: branchId,
        }
      : {
          sessionID,
          txIndex,
        };

    this.coValueId = coValueId;
    this.currentTxID = txID;
    this.sourceTxID = undefined;
    this.tx = tx;
    this.currentMadeAt = tx.madeAt;
    this.sourceTxMadeAt = undefined;

    this.previous = previous;

    if (parsingCache) {
      this.changes = parsingCache.changes;
      this.meta = parsingCache.meta;
    } else {
      // Decoding the trusting transactions here because they might be useful in the permissions checks
      if (this.tx.privacy === "trusting") {
        this.changes = safeParseJSON(this.tx.changes);

        if (this.tx.meta) {
          this.meta = safeParseJSON(this.tx.meta);
        }
      }
    }
  }

  // The TxID that refers to the current position in the session map
  // If this is a merged transaction, the txID is the TxID of the merged transaction
  get txID() {
    return this.sourceTxID ?? this.currentTxID;
  }

  // The madeAt that refers to the time when the transaction was made
  // If this is a merged transaction, the madeAt is the time when the transaction has been made in the branch
  get madeAt() {
    return this.sourceTxMadeAt ?? this.currentMadeAt;
  }

  isValidTransactionWithChanges(): this is {
    changes: JsonValue[];
    isValid: true;
  } {
    return Boolean(this.isValid && this.changes);
  }

  isProcessable(includeInvalidMetaTransactions: boolean): this is {
    changes: JsonValue[];
  } {
    return Boolean(
      this.changes && (includeInvalidMetaTransactions || this.isValid),
    );
  }

  markValid() {
    const validityChanged = this.isValid === false;
    this.isValid = true;
    this.validationErrorMessage = undefined;

    if (this.stage === "to-validate") {
      this.stage = "validated";
      this.dispatchTransaction(this);
    }

    if (this.stage === "processed" && validityChanged) {
      this.dispatchTransaction(this);
    }
  }

  markInvalid(errorMessage: string, attributes?: Record<string, JsonValue>) {
    const validityChanged = this.isValid === true;
    this.isValid = false;

    this.validationErrorMessage = errorMessage;
    if (logPermissionErrors === true) {
      logger.error("Invalid transaction: " + errorMessage, {
        coValueId: this.coValueId,
        txID: this.txID,
        author: this.author,
        ...attributes,
      });
    }

    if (this.stage === "processed" && validityChanged) {
      this.dispatchTransaction(this);
    }

    if (this.stage === "to-validate") {
      this.stage = "validated";
    }
  }

  markAsProcessed() {
    this.stage = "processed";
  }

  markAsToValidate() {
    this.stage = "to-validate";
  }
}

export type DecryptedTransaction = Omit<VerifiedTransaction, "changes"> & {
  changes: JsonValue[];
};

export type AvailableCoValueCore = CoValueCore & { verified: VerifiedState };

export class CoValueCore {
  // context
  readonly node: LocalNode;
  private readonly crypto: CryptoProvider;
  // Whether the coValue is deleted
  public isDeleted: boolean = false;

  // state
  id: RawCoID;
  private _verified: VerifiedState | null;
  /** Holds the fundamental syncable content of a CoValue,
   * consisting of the header (verified by hash -> RawCoID)
   * and the sessions (verified by signature).
   *
   * It does not do any *validation* or *decryption* and as such doesn't
   * depend on other CoValues or the LocalNode.
   *
   * `CoValueCore.verified` may be null when a CoValue is requested to be
   * loaded but no content has been received from storage or peers yet.
   * In this case, it acts as a centralised entry to keep track of peer loading
   * state and to subscribe to its content when it does become available. */
  get verified() {
    return this._verified;
  }

  private readonly loadingStatuses = new Map<
    PeerID | "storage",
    | {
        type: "unknown" | "pending" | "available" | "unavailable";
      }
    | {
        type: "errored";
        error: unknown;
      }
  >();

  // Tracks why we have lastKnownState (separate from loadingStatuses)
  // - "garbageCollected": was in memory, got GC'd
  // - "onlyKnownState": checked storage, found knownState, but didn't load full content
  #lastKnownStateSource?: "garbageCollected" | "onlyKnownState";

  // Cache the knownState when transitioning to garbageCollected/onlyKnownState
  // Used during peer reconciliation to send accurate LOAD requests
  #lastKnownState?: CoValueKnownState;

  // cached state and listeners
  private _cachedContent?: RawCoValue;
  readonly listeners: Set<(core: CoValueCore, unsub: () => void) => void> =
    new Set();
  private counter: UpDownCounter;

  constructor(id: RawCoID, node: LocalNode) {
    this.crypto = node.crypto;
    this.id = id;
    this._verified = null;
    this.node = node;

    this.counter = metrics
      .getMeter("cojson")
      .createUpDownCounter("jazz.covalues.loaded", {
        description: "The number of covalues in the system",
        unit: "covalue",
        valueType: ValueType.INT,
      });

    this.updateCounter(null);
  }

  get loadingState() {
    if (this.verified) {
      return "available";
    }

    // Check for lastKnownStateSource (garbageCollected or onlyKnownState)
    if (this.#lastKnownStateSource) {
      return this.#lastKnownStateSource;
    }

    // Check for pending peers FIRST - loading takes priority over other states
    for (const peer of this.loadingStatuses.values()) {
      if (peer.type === "pending") {
        return "loading";
      }
    }

    if (this.loadingStatuses.size === 0) {
      return "unknown";
    }

    for (const peer of this.loadingStatuses.values()) {
      if (peer.type === "unknown") {
        return "unknown";
      }
    }

    return "unavailable";
  }

  hasMissingDependencies() {
    return this.missingDependencies.size > 0;
  }

  isAvailable(): this is AvailableCoValueCore {
    return this.hasVerifiedContent();
  }

  isKnownStateAvailable(): boolean {
    return (
      this.loadingState === "available" ||
      this.loadingState === "onlyKnownState" ||
      this.loadingState === "garbageCollected"
    );
  }

  isCompletelyDownloaded(): boolean {
    if (!this.hasVerifiedContent()) {
      return false;
    }

    if (this.isStreaming()) {
      return false;
    }

    if (this.incompleteDependencies.size > 0) {
      return false;
    }

    return true;
  }

  isStreaming() {
    return this.verified?.isStreaming() ?? false;
  }

  hasVerifiedContent(): this is AvailableCoValueCore {
    return !!this.verified;
  }

  /**
   * Returns the CoValue data as NewContentMessage objects, excluding the transactions that are part of the given known state.
   *
   * Used to serialize the CoValue data to send it to peers and storage.
   */
  newContentSince(
    knownState?: CoValueKnownState,
  ): NewContentMessage[] | undefined {
    return this.verified?.newContentSince(knownState);
  }

  isErroredInPeer(peerId: PeerID) {
    return this.getLoadingStateForPeer(peerId) === "errored";
  }

  getErroredInPeerError(peerId: PeerID) {
    const loadingState = this.loadingStatuses.get(peerId);
    if (loadingState?.type === "errored") {
      return loadingState.error;
    }
    return undefined;
  }

  waitFor(opts: {
    predicate: (value: CoValueCore) => boolean;
    onSuccess: (value: CoValueCore) => void;
  }) {
    const { predicate, onSuccess } = opts;
    this.subscribe((core, unsubscribe) => {
      if (predicate(core)) {
        unsubscribe();
        onSuccess(core);
      }
    }, true);
  }

  waitForAsync(callback: (value: CoValueCore) => boolean) {
    return new Promise<CoValueCore>((resolve) => {
      this.waitFor({ predicate: callback, onSuccess: resolve });
    });
  }

  waitForAvailableOrUnavailable(): Promise<CoValueCore> {
    return this.waitForAsync(
      (core) => core.isAvailable() || core.loadingState === "unavailable",
    );
  }

  waitForAvailable(): Promise<CoValueCore> {
    return this.waitForAsync((core) => core.isAvailable());
  }

  waitForFullStreaming(): Promise<CoValueCore> {
    return this.waitForAsync(
      (core) => core.isAvailable() && !core.isStreaming(),
    );
  }

  getLoadingStateForPeer(peerId: PeerID) {
    return this.loadingStatuses.get(peerId)?.type ?? "unknown";
  }

  private updateCounter(previousState: string | null) {
    const newState = this.loadingState;

    if (previousState !== newState) {
      if (previousState) {
        this.counter.add(-1, { state: previousState });
      }
      this.counter.add(1, { state: newState });
    }
  }

  /**
   * Removes the CoValue content from memory but keeps a shell with cached knownState.
   * This enables accurate LOAD requests during peer reconciliation.
   *
   * @returns true if the coValue was successfully unmounted, false otherwise
   */
  unmount(): boolean {
    return this.node.internalUnmountCoValue(this.id);
  }

  /**
   * Decrements the counter for the current loading state.
   * Used during unmount to properly track state transitions.
   * @internal
   */
  decrementLoadingStateCounter() {
    this.counter.add(-1, { state: this.loadingState });
  }

  markNotFoundInPeer(peerId: PeerID) {
    const previousState = this.loadingState;
    this.loadingStatuses.set(peerId, { type: "unavailable" });
    this.updateCounter(previousState);
    this.scheduleNotifyUpdate();
  }

  markFoundInPeer(peerId: PeerID, previousState: string) {
    this.loadingStatuses.set(peerId, { type: "available" });
    this.updateCounter(previousState);
    this.scheduleNotifyUpdate();
  }

  /**
   * Clean up cached state when CoValue becomes available.
   * Called after the CoValue transitions from garbageCollected/onlyKnownState to available.
   */
  private cleanupLastKnownState() {
    // Clear both fields - in-memory verified state is now authoritative
    this.#lastKnownStateSource = undefined;
    this.#lastKnownState = undefined;
  }

  /**
   * Initialize this CoValueCore as a garbageCollected shell.
   * Called when creating a replacement CoValueCore after unmounting.
   */
  setGarbageCollectedState(knownState: CoValueKnownState) {
    // Only set garbageCollected state if storage is active
    // Without storage, we can't reload the CoValue anyway
    if (!this.node.storage) {
      return;
    }

    // Transition counter from 'unknown' (set by constructor) to 'garbageCollected'
    // previousState will be 'unknown', newState will be 'garbageCollected'
    const previousState = this.loadingState;
    this.#lastKnownStateSource = "garbageCollected";
    this.#lastKnownState = knownState;
    this.updateCounter(previousState);
  }

  missingDependencies = new Set<RawCoID>();

  isCircularDependency(dependency: CoValueCore) {
    if (dependency.id === this.id) {
      return true;
    }

    const visited = new Set<RawCoID>();
    const stack = [dependency];

    while (stack.length > 0) {
      const current = stack.pop();

      if (!current) {
        return false;
      }

      visited.add(current.id);

      for (const dependency of current.dependencies) {
        if (dependency === this.id) {
          return true;
        }

        if (!visited.has(dependency)) {
          stack.push(this.node.getCoValue(dependency));
        }
      }
    }

    return false;
  }

  newContentQueue: {
    msg: NewContentMessage;
    from: PeerState | "storage" | "import";
  }[] = [];
  /**
   * Add a new content to the queue and handle it when the dependencies are available
   */
  addNewContentToQueue(
    msg: NewContentMessage,
    from: PeerState | "storage" | "import",
  ) {
    const alreadyEnqueued = this.newContentQueue.length > 0;

    this.newContentQueue.push({ msg, from });

    if (alreadyEnqueued) {
      return;
    }

    this.waitFor({
      predicate: (core) => !core.hasMissingDependencies(),
      onSuccess: () => {
        const enqueuedNewContent = this.newContentQueue;
        this.newContentQueue = [];

        for (const { msg, from } of enqueuedNewContent) {
          this.node.syncManager.handleNewContent(msg, from);
        }
      },
    });
  }

  addDependencyFromHeader(header: CoValueHeader) {
    for (const dep of getDependenciesFromHeader(header)) {
      this.addDependency(dep);
    }
  }

  provideHeader(
    header: CoValueHeader,
    streamingKnownState?: KnownStateSessions,
    skipVerify?: boolean,
  ) {
    if (this._verified?.sessionCount) {
      throw new Error(
        "CoValueCore: provideHeader called on coValue with verified sessions present!",
      );
    }

    // Create VerifiedState - Rust validates uniqueness and id match unless skipVerify is true
    try {
      this._verified = new VerifiedState(
        this.id,
        this.node.crypto,
        header,
        streamingKnownState,
        skipVerify,
      );
    } catch (e) {
      // Rust validation failed (invalid uniqueness or id mismatch)
      logger.error("Header validation failed", {
        id: this.id,
        header,
        error: e instanceof Error ? e.message : String(e),
      });
      return false;
    }

    // Only add dependencies after successful validation
    this.addDependencyFromHeader(header);

    // Clean up if transitioning from garbageCollected/onlyKnownState
    if (this.isAvailable()) {
      this.cleanupLastKnownState();
    }

    return true;
  }

  markErrored(peerId: PeerID, error: unknown) {
    const previousState = this.loadingState;
    this.loadingStatuses.set(peerId, { type: "errored", error });
    this.updateCounter(previousState);
    this.scheduleNotifyUpdate();
  }

  markPending(peerId: PeerID) {
    const previousState = this.loadingState;
    this.loadingStatuses.set(peerId, { type: "pending" });
    this.updateCounter(previousState);
    this.scheduleNotifyUpdate();
  }

  contentInClonedNodeWithDifferentAccount(account: ControlledAccountOrAgent) {
    return this.node
      .loadCoValueAsDifferentAgent(this.id, account.agentSecret, account.id)
      .then((core) => core.getCurrentContent());
  }

  /**
   * Returns the known state considering the known state of the streaming source
   *
   * Used to correctly manage the content & subscriptions during the content streaming process
   */
  knownStateWithStreaming(): CoValueKnownState {
    if (this.verified) {
      return this.verified.knownStateWithStreaming();
    }

    return this.knownState();
  }

  /**
   * Returns the known state of the CoValue
   *
   * For garbageCollected/onlyKnownState CoValues, returns the cached knownState.
   */
  knownState(): CoValueKnownState {
    // 1. If we have verified content in memory, use that (authoritative)
    if (this.verified) {
      return this.verified.knownState();
    }

    // 2. If we have last known state (GC'd or onlyKnownState), use that
    if (this.#lastKnownState) {
      return this.#lastKnownState;
    }

    // 3. Fallback to empty state (truly unknown CoValue)
    return emptyKnownState(this.id);
  }

  /**
   * Returns a new frontier object from the CoValue's known state
   */
  frontier(): CoValueFrontier {
    return { ...this.knownState().sessions };
  }

  /**
   * Returns a known state message to signal to the peer that the coValue doesn't need to be synced anymore
   *
   * Implemented to be backward compatible with clients that don't support deleted coValues
   */
  stopSyncingKnownStateMessage(
    peerKnownState: CoValueKnownState | undefined,
  ): KnownStateMessage {
    if (!peerKnownState) {
      return {
        action: "known",
        ...this.knownState(),
      };
    }

    const knownState = cloneKnownState(this.knownState());

    // We combine everything for backward compatibility with clients that don't support deleted coValues
    // This way they won't try to sync their own content that we have discarded because the coValue is deleted
    combineKnownStateSessions(knownState.sessions, peerKnownState.sessions);

    return {
      action: "known",
      ...knownState,
    };
  }

  get meta(): JsonValue {
    return this.verified?.header.meta ?? null;
  }

  nextTransactionID(): TransactionID {
    if (!this.verified) {
      throw new Error(
        "CoValueCore: nextTransactionID called on coValue without verified state",
      );
    }

    // This is an ugly hack to get a unique but stable session ID for editing the current account
    const sessionID =
      this.verified.header.meta?.type === "account"
        ? (this.node.currentSessionID.replace(
            this.node.getCurrentAgent().id,
            this.node.getCurrentAgent().currentAgentID(),
          ) as SessionID)
        : this.node.currentSessionID;

    return {
      sessionID,
      txIndex: this.verified.getTransactionsCount(sessionID) || 0,
    };
  }

  addDependenciesFromContentMessage(newContent: NewContentMessage) {
    const dependencies = getDependenciesFromContentMessage(this, newContent);

    for (const dependency of dependencies) {
      this.addDependency(dependency);
    }
  }

  #isDeleteTransaction(
    sessionID: SessionID,
    newTransactions: Transaction[],
    skipVerify: boolean,
  ) {
    if (!this.verified) {
      return {
        value: false,
      };
    }

    // Detect + validate delete transactions during ingestion
    // Delete transactions are:
    // - in a delete session (sessionID ends with `$`)
    // - trusting (unencrypted)
    // - have meta `{ deleted: true }`
    let deleteTransaction: Transaction | undefined = undefined;

    if (isDeleteSessionID(sessionID)) {
      const txCount = this.verified.getTransactionsCount(sessionID) ?? 0;
      if (txCount > 0 || newTransactions.length > 1) {
        return {
          value: true,
          err: {
            type: "DeleteTransactionRejected",
            id: this.id,
            sessionID,
            reason: "InvalidDeleteTransaction",
            error: new Error(
              "Delete transaction must be the only transaction in the session",
            ),
          } as const,
        };
      }

      const firstTransaction = newTransactions[0];
      const deleteMarker =
        firstTransaction && this.#getDeleteMarker(firstTransaction);

      if (deleteMarker) {
        deleteTransaction = firstTransaction;

        if (deleteMarker.deleted !== this.id) {
          return {
            value: true,
            err: {
              type: "DeleteTransactionRejected",
              id: this.id,
              sessionID,
              reason: "InvalidDeleteTransaction",
              error: new Error(
                `Delete transaction ID mismatch: expected ${this.id}, got ${deleteMarker.deleted}`,
              ),
            } as const,
          };
        }
      }

      if (this.isGroupOrAccount()) {
        return {
          value: true,
          err: {
            type: "DeleteTransactionRejected",
            id: this.id,
            sessionID,
            reason: "CoValueNotDeletable",
            error: new Error("Cannot delete Group or Account coValues"),
          },
        } as const;
      }
    }

    if (!skipVerify && deleteTransaction) {
      const author = accountOrAgentIDfromSessionID(sessionID);

      const permission = this.#canAuthorDeleteCoValueAtTime(
        author,
        deleteTransaction.madeAt,
      );

      if (!permission.ok) {
        return {
          value: true,
          err: {
            type: "DeleteTransactionRejected",
            id: this.id,
            sessionID,
            author,
            reason: permission.reason,
            error: new Error(permission.message),
          },
        } as const;
      }
    }

    return {
      value: Boolean(deleteTransaction),
    };
  }

  /**
   * Apply new transactions that were not generated by the current node to the CoValue
   */
  tryAddTransactions(
    sessionID: SessionID,
    newTransactions: Transaction[],
    newSignature: Signature,
    skipVerify: boolean = false,
  ) {
    if (newTransactions.length === 0) {
      return;
    }

    let signerID: SignerID | undefined;

    // sync should never try to add transactions to a deleted coValue
    // this can only happen if `tryAddTransactions` is called directly, without going through `handleNewContent`
    if (this.isDeleted && !isDeleteSessionID(sessionID)) {
      return {
        type: "CoValueDeleted",
        id: this.id,
        error: new Error("Cannot add transactions to a deleted coValue"),
      } as const;
    }

    if (!skipVerify) {
      const result = this.node.resolveAccountAgent(
        accountOrAgentIDfromSessionID(sessionID),
        "Expected to know signer of transaction",
      );

      if (result.error || !result.value) {
        return {
          type: "ResolveAccountAgentError",
          id: this.id,
          error: result.error,
        } as const;
      }

      signerID = this.crypto.getAgentSignerID(result.value);
    }

    if (!this.verified) {
      return {
        type: "TriedToAddTransactionsWithoutVerifiedState",
        id: this.id,
        error: undefined,
      };
    }

    const isDeleteTransaction = this.#isDeleteTransaction(
      sessionID,
      newTransactions,
      skipVerify,
    );

    if (isDeleteTransaction.err) {
      return isDeleteTransaction.err;
    }

    try {
      this.verified.tryAddTransactions(
        sessionID,
        signerID,
        newTransactions,
        newSignature,
        skipVerify,
      );

      // Mark deleted state when a delete marker transaction is accepted.
      // - In skipVerify mode (storage shards), we accept + mark without permission checks.
      // - In verify mode, we only reach here if the delete permission check passed.
      if (isDeleteTransaction.value) {
        this.#markAsDeleted();
      }

      this.processNewTransactions();
      this.scheduleNotifyUpdate();
      this.invalidateDependants();
    } catch (e) {
      return { type: "InvalidSignature", id: this.id, error: e } as const;
    }
  }

  #markAsDeleted() {
    this.isDeleted = true;
    this.verified?.markAsDeleted();
  }

  /**
   * Replace a single session's content with authoritative data from the server.
   * Rebuilds the VerifiedState from scratch with all existing sessions except
   * the replaced one, then applies the authoritative content for that session.
   * Used during signature mismatch recovery.
   */
  replaceSessionContent(
    sessionID: SessionID,
    authoritativeContent: SessionNewContent[],
  ): void {
    if (!this.verified) {
      throw new Error(
        "CoValueCore: replaceSessionContent called without verified state",
      );
    }

    const knownStateBefore = this.knownState();
    const oldVerified = this.verified;

    // Build a fresh VerifiedState
    const newVerified = new VerifiedState(
      this.id,
      this.node.crypto,
      oldVerified.header,
    );

    // Replay all sessions except the one being replaced
    for (const [
      existingSessionID,
      sessionLog,
    ] of oldVerified.sessionEntries()) {
      if (existingSessionID === sessionID) {
        continue;
      }

      if (sessionLog.transactions.length === 0 || !sessionLog.lastSignature) {
        continue;
      }

      newVerified.tryAddTransactions(
        existingSessionID,
        undefined, // skipVerify=true, signer not needed
        sessionLog.transactions,
        sessionLog.lastSignature,
        true, // skipVerify — already verified
      );
    }

    // Apply authoritative content for the replaced session
    for (const piece of authoritativeContent) {
      newVerified.tryAddTransactions(
        sessionID,
        undefined,
        piece.newTransactions,
        piece.lastSignature,
        true, // skipVerify — authoritative from server
      );
    }

    // Swap
    this._verified = newVerified;

    // Check delete state
    this.isDeleted = false;
    for (const [sid] of newVerified.sessionEntries()) {
      if (isDeleteSessionID(sid)) {
        this.isDeleted = true;
        break;
      }
    }

    // Clear all derived transaction state so it's rebuilt from the new VerifiedState
    this.verifiedTransactions = [];
    this.verifiedTransactionsKnownSessions = {};
    this.lastVerifiedTransactionBySessionID = {};
    this.toValidateTransactions = [];
    this.toProcessTransactions = [];
    this.toDecryptTransactions = [];
    this.toParseMetaTransactions = [];
    this.#fwwWinners.clear();
    this.branchStart = undefined;
    this.mergeCommits = [];
    this.earliestTxMadeAt = Number.MAX_SAFE_INTEGER;
    this.latestTxMadeAt = 0;

    // Reload transactions from the new VerifiedState
    this.loadVerifiedTransactionsFromLogs();
    this.parseNewTransactions(false);

    this._cachedContent?.rebuildFromCore();
    this.scheduleNotifyUpdate();
    this.invalidateDependants();
    this.node.syncManager.syncLocalTransaction(
      this._verified,
      knownStateBefore,
    );
  }

  /**
   * Get the parsed (decrypted) changes and meta for a transaction.
   * Checks the parsing cache first, then falls back to searching verified transactions.
   * Used by recovery to re-create divergent transactions on a conflict session.
   */
  getParsedTransaction(
    tx: Transaction,
  ): { changes: JsonValue[]; meta: JsonObject | undefined } | undefined {
    const cached = this.parsingCache.get(tx);
    if (cached) return cached;

    // The parsing cache is consumed by loadVerifiedTransactionsFromLogs,
    // so check verified transactions for the parsed data
    for (const vt of this.verifiedTransactions) {
      if (vt.tx === tx && vt.changes) {
        return { changes: vt.changes, meta: vt.meta };
      }
    }

    return undefined;
  }

  #getDeleteMarker(tx: Transaction): { deleted: RawCoID } | undefined {
    if (tx.privacy !== "trusting") {
      return;
    }
    if (!tx.meta) {
      return;
    }
    const meta = safeParseJSON(tx.meta);

    return meta && typeof meta.deleted === "string"
      ? (meta as { deleted: RawCoID })
      : undefined;
  }

  #canAuthorDeleteCoValueAtTime(
    author: RawAccountID | AgentID,
    madeAt: number,
  ):
    | { ok: true }
    | {
        ok: false;
        reason: DeleteTransactionRejectedError["reason"];
        message: string;
      } {
    if (!this.verified) {
      return {
        ok: false,
        reason: "CannotVerifyPermissions",
        message: "Cannot verify delete permissions without verified state",
      };
    }

    if (this.isGroupOrAccount()) {
      return {
        ok: false,
        reason: "CoValueNotDeletable",
        message: "Cannot delete Group or Account coValues",
      };
    }

    const group = this.safeGetGroup();

    // Today, delete permission is defined in terms of group-admin on the owning group.
    // If we cannot derive that (non-owned coValues), we reject the delete when verification is required.
    if (!group) {
      return {
        ok: false,
        reason: "CannotVerifyPermissions",
        message:
          "Cannot verify delete permissions for coValues not owned by a group",
      };
    }

    const groupAtTime = group.atTime(madeAt);
    const role = groupAtTime.roleOfInternal(author);

    if (role !== "admin") {
      return {
        ok: false,
        reason: "NotAdmin",
        message: "Delete transaction rejected: author is not an admin",
      };
    }

    return { ok: true };
  }

  notifyDependants() {
    if (!this.isGroup()) {
      return;
    }

    for (const dependency of this.dependant) {
      this.node.getCoValue(dependency).scheduleNotifyUpdate();
      this.node.getCoValue(dependency).notifyDependants();
    }
  }

  invalidateDependants() {
    if (!this.isGroup()) {
      return;
    }

    for (const dependency of this.dependant) {
      this.node.getCoValue(dependency).resetParsedTransactions();
      this.node.getCoValue(dependency).invalidateDependants();
    }
  }

  private processNewTransactions() {
    if (this._cachedContent) {
      this._cachedContent.processNewTransactions();
    }
  }

  #isNotificationScheduled = false;
  #batchedUpdates = false;

  private scheduleNotifyUpdate() {
    if (this.listeners.size === 0) {
      return;
    }

    this.#batchedUpdates = true;

    if (!this.#isNotificationScheduled) {
      this.#isNotificationScheduled = true;

      queueMicrotask(() => {
        this.#isNotificationScheduled = false;

        // Check if an immediate update has been notified
        if (this.#batchedUpdates) {
          this.notifyUpdate();
        }
      });
    }
  }

  #isContentRebuildScheduled = false;
  scheduleContentRebuild() {
    if (!this._cachedContent || this.#isContentRebuildScheduled) {
      return;
    }

    this.#isContentRebuildScheduled = true;

    queueMicrotask(() => {
      this.#isContentRebuildScheduled = false;
      this._cachedContent?.rebuildFromCore();
    });
  }

  #isNotifyUpdatePaused = false;
  pauseNotifyUpdate() {
    this.#isNotifyUpdatePaused = true;
  }

  resumeNotifyUpdate() {
    this.#isNotifyUpdatePaused = false;
    this.notifyUpdate();
  }

  private notifyUpdate() {
    if (this.listeners.size === 0 || this.#isNotifyUpdatePaused) {
      return;
    }

    this.#batchedUpdates = false;

    for (const listener of this.listeners) {
      try {
        listener(this, () => {
          this.listeners.delete(listener);
        });
      } catch (e) {
        logger.error("Error in listener for coValue " + this.id, { err: e });
      }
    }
  }

  subscribe(
    listener: (core: CoValueCore, unsub: () => void) => void,
    immediateInvoke = true,
  ): () => void {
    this.listeners.add(listener);

    if (immediateInvoke) {
      listener(this, () => {
        this.listeners.delete(listener);
      });
    }

    return () => {
      this.listeners.delete(listener);
    };
  }

  validateDeletePermissions() {
    if (!this.verified) {
      return {
        ok: false,
        reason: "CannotVerifyPermissions",
        message: "Cannot verify delete permissions without verified state",
      };
    }

    if (this.isGroupOrAccount()) {
      return {
        ok: false,
        reason: "CoValueNotDeletable",
        message: "Cannot delete Group or Account coValues",
      };
    }

    const group = this.safeGetGroup();
    if (!group) {
      return {
        ok: false,
        reason: "CannotVerifyPermissions",
        message:
          "Cannot verify delete permissions for coValues not owned by a group",
      };
    }

    const role = group.myRole();
    if (role !== "admin") {
      return {
        ok: false,
        reason: "NotAdmin",
        message:
          "The current account lacks admin permissions to delete this coValue",
      };
    }

    return { ok: true };
  }

  /**
   * Creates a delete marker transaction for this CoValue and sets the coValue as deleted
   *
   * Constraints:
   * - Account and Group CoValues cannot be deleted.
   * - Only admins can delete a coValue.
   */
  deleteCoValue() {
    if (this.isDeleted) {
      return;
    }

    const result = this.validateDeletePermissions();
    if (!result.ok) {
      throw new Error(result.message);
    }

    this.makeTransaction(
      [], // Empty changes array
      "trusting", // Unencrypted
      { deleted: this.id }, // Delete metadata
    );
  }

  /**
   * Creates a new transaction with local changes and syncs it to all peers
   */
  makeTransaction(
    changes: JsonValue[],
    privacy: "private" | "trusting",
    meta?: JsonObject,
    madeAt?: number,
    isConflict?: boolean,
  ): boolean {
    if (!this.verified) {
      throw new Error(
        "CoValueCore: makeTransaction called on coValue without verified state",
      );
    }
    const isDeleteTransaction = Boolean(meta?.deleted);

    if (this.isDeleted && !isDeleteTransaction) {
      logger.error("Cannot make transaction on a deleted coValue", {
        id: this.id,
      });
      return false;
    }

    // This is an ugly hack to get a unique but stable session ID for editing the current account
    let sessionID =
      this.verified.header.meta?.type === "account"
        ? (this.node.currentSessionID.replace(
            this.node.getCurrentAgent().id,
            this.node.getCurrentAgent().currentAgentID(),
          ) as SessionID)
        : this.node.currentSessionID;

    if (isDeleteTransaction) {
      sessionID = this.crypto.newDeleteSessionID(
        this.node.getCurrentAccountOrAgentID(),
      );
    }

    if (isConflict) {
      sessionID = toConflictSessionID(sessionID as ActiveSessionID);
    }

    const signerAgent = this.node.getCurrentAgent();

    let result: { signature: Signature; transaction: Transaction };

    const knownStateBefore = this.knownState();

    if (privacy === "private") {
      const { secret: keySecret, id: keyID } = this.getCurrentReadKey();

      if (!keySecret) {
        throw new Error("Can't make transaction without read key secret");
      }

      result = this.verified.makeNewPrivateTransaction(
        sessionID,
        signerAgent,
        changes,
        keyID,
        keySecret,
        meta,
        madeAt ?? this.node.stampNow(),
      );
    } else {
      result = this.verified.makeNewTrustingTransaction(
        sessionID,
        signerAgent,
        changes,
        meta,
        madeAt ?? this.node.stampNow(),
      );
    }

    if (isDeleteTransaction) {
      this.#markAsDeleted();
    }

    const { transaction } = result;

    // Assign pre-parsed meta and changes to skip the parse/decrypt operation when loading
    // this transaction in the current content
    this.parsingCache.set(transaction, { changes, meta });

    this.node.syncManager.recordTransactionsSize([transaction], "local");

    this.processNewTransactions();
    this.addDependenciesFromNewTransaction(transaction);

    // force immediate notification because local updates may come from the UI
    // where we need synchronous updates
    this.notifyUpdate();
    this.node.syncManager.syncLocalTransaction(this.verified, knownStateBefore);

    if (madeAt === undefined) {
      // We don't revalidate the dependants transactions because we assume that transactions that you are
      // creating "now" on groups don't affect the validity of transactions you already have in memory.
      // For validity I mean:
      // - ability to decrypt a transaction
      // - that the account that made the transaction had enough rights to do so
      this.notifyDependants();
    } else {
      // If the transaction is not made "now", we need to revalidate the dependants transactions
      // because the new transaction might affect the validity of the dependants transactions
      this.invalidateDependants();
    }

    return true;
  }

  addDependenciesFromNewTransaction(transaction: Transaction) {
    if (this.verified?.header.ruleset.type === "group") {
      for (const dependency of getDependenciesFromGroupRawTransactions([
        transaction,
      ])) {
        this.addDependency(dependency);
      }
    }
  }

  getCurrentContent(options?: { ignorePrivateTransactions: true }): RawCoValue {
    if (!this.verified) {
      throw new Error(
        "CoValueCore: getCurrentContent called on coValue without verified state",
      );
    }

    if (!options?.ignorePrivateTransactions && this._cachedContent) {
      return this._cachedContent;
    }

    const newContent = coreToCoValue(this as AvailableCoValueCore, options);

    if (!options?.ignorePrivateTransactions) {
      this._cachedContent = newContent;
    }

    return newContent;
  }

  // The starting point of the branch, in case this CoValue is a branch
  branchStart: BranchStartCommit["from"] | undefined;

  // The list of merge commits that have been made
  mergeCommits: MergeCommit[] = [];
  branches: BranchPointerCommit[] = [];
  earliestTxMadeAt: number = Number.MAX_SAFE_INTEGER;
  latestTxMadeAt: number = 0;

  // Reset the parsed transactions and branches, to validate them again from scratch when the group is updated
  resetParsedTransactions() {
    const verifiedTransactions = this.verifiedTransactions;

    if (verifiedTransactions.length === 0) {
      return;
    }

    this.branchStart = undefined;
    this.mergeCommits = [];

    // Store the validity of the transactions before resetting the parsed transactions
    const validityBeforeReset = new Array<boolean>(verifiedTransactions.length);
    this.verifiedTransactions.forEach((transaction, index) => {
      transaction.markAsToValidate();
      validityBeforeReset[index] = transaction.isValidTransactionWithChanges();
    });

    this.toValidateTransactions = verifiedTransactions.slice();
    this.toProcessTransactions = [];
    this.toDecryptTransactions = [];
    this.toParseMetaTransactions = [];
    this.#fwwWinners.clear();

    this.parseNewTransactions(false);

    // Check if the validity of the transactions has changed after resetting the parsed transactions
    // If it has, we need to rebuild the content to reflect the new validity
    const sameAsBefore = validityBeforeReset.every(
      (valid, index) =>
        valid === verifiedTransactions[index]?.isValidTransactionWithChanges(),
    );

    if (!sameAsBefore) {
      this._cachedContent?.rebuildFromCore();
    }

    this.scheduleNotifyUpdate();
  }

  verifiedTransactions: VerifiedTransaction[] = [];
  toValidateTransactions: VerifiedTransaction[] = [];
  toDecryptTransactions: VerifiedTransaction[] = [];
  toParseMetaTransactions: VerifiedTransaction[] = [];
  toProcessTransactions: VerifiedTransaction[] = [];

  private verifiedTransactionsKnownSessions: CoValueKnownState["sessions"] = {};

  private lastVerifiedTransactionBySessionID: Record<
    SessionID,
    VerifiedTransaction
  > = {};

  private parsingCache = new Map<
    Transaction,
    { changes: JsonValue[]; meta: JsonObject | undefined }
  >();

  /**
   * Loads the new transaction from the SessionMap into verifiedTransactions as a VerifiedTransaction.
   *
   * If the transaction is already loaded from the SessionMap in the past, it will not be loaded again.
   *
   * Used to have a fast way to iterate over the CoValue transactions, and track their validation/decoding state.

  * @internal
   * */
  loadVerifiedTransactionsFromLogs() {
    if (!this.verified) {
      return;
    }

    const isBranched = this.isBranched();

    for (const [sessionID, sessionLog] of this.verified.sessionEntries()) {
      const count = this.verifiedTransactionsKnownSessions[sessionID] ?? 0;

      for (
        let txIndex = count;
        txIndex < sessionLog.transactions.length;
        txIndex++
      ) {
        const tx = sessionLog.transactions[txIndex];
        if (!tx) {
          continue;
        }

        const cache = this.parsingCache.get(tx);
        if (cache) {
          this.parsingCache.delete(tx);
        }

        const verifiedTransaction = new VerifiedTransaction(
          this.id,
          sessionID,
          txIndex,
          tx,
          isBranched ? this.id : undefined,
          cache,
          this.lastVerifiedTransactionBySessionID[sessionID],
          this.dispatchTransaction,
        );

        if (verifiedTransaction.madeAt > this.latestTxMadeAt) {
          this.latestTxMadeAt = verifiedTransaction.madeAt;
        }

        if (verifiedTransaction.madeAt < this.earliestTxMadeAt) {
          this.earliestTxMadeAt = verifiedTransaction.madeAt;
        }

        this.verifiedTransactions.push(verifiedTransaction);
        this.dispatchTransaction(verifiedTransaction);
        this.lastVerifiedTransactionBySessionID[sessionID] =
          verifiedTransaction;
      }

      this.verifiedTransactionsKnownSessions[sessionID] =
        sessionLog.transactions.length;
    }
  }

  dispatchTransaction = (transaction: VerifiedTransaction) => {
    if (transaction.stage === "to-validate") {
      this.toValidateTransactions.push(transaction);
      return;
    }

    if (transaction.stage === "processed") {
      this.scheduleContentRebuild();
      return;
    }

    if (transaction.changes) {
      this.toProcessTransactions.push(transaction);
    } else {
      this.toDecryptTransactions.push(transaction);
    }

    if (transaction.meta) {
      this.toParseMetaTransactions.push(transaction);
    }
  };

  /**
   * Iterates over the verifiedTransactions and marks them as valid or invalid, based on the group membership of the authors of the transactions  .
   */
  private determineValidTransactions() {
    determineValidTransactions(this);
    this.toValidateTransactions = [];
  }

  #fwwWinners: Map<string, VerifiedTransaction> = new Map();

  /**
   * Parses the meta information of a transaction, and set the branchStart and mergeCommits.
   */
  private parseMetaInformation(transaction: VerifiedTransaction) {
    if (!transaction.meta) {
      return;
    }

    // Branch related meta information
    if (this.isBranched()) {
      // Check if the transaction is a branch start
      if ("from" in transaction.meta) {
        const meta = transaction.meta as BranchStartCommit;

        if (this.branchStart) {
          this.branchStart = combineKnownStateSessions(
            this.branchStart,
            meta.from,
          );
        } else {
          this.branchStart = meta.from;
        }
      }
    }

    // Check if the transaction is a branch pointer
    if ("branch" in transaction.meta) {
      const branch = transaction.meta as BranchPointerCommit;

      this.branches.push(branch);
    }

    // Check if the transaction is a merged checkpoint for a branch
    if ("merged" in transaction.meta) {
      const mergeCommit = transaction.meta as MergeCommit;
      this.mergeCommits.push(mergeCommit);
    }

    if ("fww" in transaction.meta) {
      const fwwKey = transaction.meta.fww as string;
      const currentWinner = this.#fwwWinners.get(fwwKey);

      // First-writer-wins: keep the transaction with the smallest madeAt
      // compareTransactions returns < 0 if transaction is earlier than currentWinner
      if (
        !currentWinner ||
        this.compareTransactions(transaction, currentWinner) < 0
      ) {
        if (currentWinner) {
          currentWinner.markInvalid(
            `Transaction is not the first writer for fww key "${fwwKey}"`,
          );
        }

        this.#fwwWinners.set(fwwKey, transaction);
      } else {
        transaction.markInvalid(
          `Transaction is not the first writer for fww key "${fwwKey}"`,
        );
      }
    }

    // Check if the transaction has been merged from a branch
    if ("mi" in transaction.meta) {
      const meta = transaction.meta as MergedTransactionMetadata;

      // Check if the transaction is a merge commit
      const previousTransaction = transaction.previous;
      const sessionID = meta.s ?? previousTransaction?.txID.sessionID;

      if (meta.t) {
        transaction.sourceTxMadeAt = transaction.currentMadeAt - meta.t;
      } else if (previousTransaction) {
        transaction.sourceTxMadeAt = previousTransaction.madeAt;
      }

      // Check against tampering of the meta.t value to write transaction after the access revocation
      if (
        transaction.sourceTxMadeAt &&
        transaction.sourceTxMadeAt > transaction.currentMadeAt
      ) {
        transaction.markInvalid(
          "Transaction sourceMadeAt is after the currentMadeAt",
          {
            sourceTxMadeAt: transaction.sourceTxMadeAt,
            currentMadeAt: transaction.currentMadeAt,
          },
        );
      }

      if (sessionID) {
        transaction.sourceTxID = {
          sessionID,
          txIndex: meta.mi,
          branch: meta.b ?? previousTransaction?.txID.branch,
        };
      } else {
        logger.error("Merge commit without session ID", {
          txID: transaction.txID,
          prevTxID: previousTransaction?.txID ?? null,
        });
      }
    }
  }

  /**
   * Loads the new transactions from SessionMap and:
   * - Validates each transaction based on the group membership of the authors
   * - Decodes the changes & meta for each transaction
   * - Parses the meta information of the transaction
   */
  private parseNewTransactions(ignorePrivateTransactions: boolean) {
    if (!this.isAvailable()) {
      return;
    }
    this.loadVerifiedTransactionsFromLogs();
    this.determineValidTransactions();

    if (!ignorePrivateTransactions) {
      const toDecryptTransactions = this.toDecryptTransactions;
      this.toDecryptTransactions = [];
      for (const transaction of toDecryptTransactions) {
        decryptTransactionChangesAndMeta(this, transaction);
        this.dispatchTransaction(transaction);
      }
    }

    const toParseMetaTransactions = this.toParseMetaTransactions;
    this.toParseMetaTransactions = [];
    for (const transaction of toParseMetaTransactions) {
      this.parseMetaInformation(transaction);
    }
  }

  /**
   * Returns the valid transactions matching the criteria specified in the options
   */
  getValidTransactions(options?: {
    ignorePrivateTransactions: boolean;
    // The range, described as knownState sessions, to filter the transactions returned
    from?: CoValueKnownState["sessions"];
    to?: CoValueKnownState["sessions"];
    knownTransactions?: Record<RawCoID, number>;
    includeInvalidMetaTransactions?: boolean;
    // If true, the branch source transactions will be skipped. Used to gather the transactions for the merge operation.
    skipBranchSource?: boolean;
  }): DecryptedTransaction[] {
    if (!this.verified) {
      return [];
    }

    this.parseNewTransactions(options?.ignorePrivateTransactions ?? false);

    const matchingTransactions: DecryptedTransaction[] = [];

    const source = getBranchSource(this);

    const from = options?.from;
    const to = options?.to;

    const knownTransactions = options?.knownTransactions?.[this.id] ?? 0;

    // Include invalid transactions in the result (only transactions invalidated by metadata parsing are included e.g. init transactions)
    // permission errors are still not included
    const includeInvalidMetaTransactions =
      options?.includeInvalidMetaTransactions ?? false;

    for (
      let i = knownTransactions;
      i < this.toProcessTransactions.length;
      i++
    ) {
      const transaction = this.toProcessTransactions[i]!;

      if (!transaction.isProcessable(includeInvalidMetaTransactions)) {
        continue;
      }

      // Using the currentTxID to filter the transactions, because the TxID is modified by the merge meta
      const txID = transaction.currentTxID;

      const fromIdx = from?.[txID.sessionID] ?? -1;

      // Load the to filter index. Sessions that are not in the to filter will be skipped
      const toIdx = to?.[txID.sessionID] ?? Infinity;

      // The txIndex starts at 0 and from/to are referring to the count of transactions
      if (fromIdx > txID.txIndex || toIdx < txID.txIndex) {
        continue;
      }

      transaction.markAsProcessed();
      matchingTransactions.push(transaction);
    }

    if (options?.knownTransactions !== undefined) {
      options.knownTransactions[this.id] = this.toProcessTransactions.length;
    }

    // If this is a branch, we load the valid transactions from the source
    if (source && this.branchStart && !options?.skipBranchSource) {
      const sourceTransactions = source.getValidTransactions({
        includeInvalidMetaTransactions,
        knownTransactions: options?.knownTransactions,
        to: this.branchStart,
        ignorePrivateTransactions: options?.ignorePrivateTransactions ?? false,
      });

      for (const transaction of sourceTransactions) {
        matchingTransactions.push(transaction);
      }
    }

    return matchingTransactions;
  }

  /**
   * The CoValues that this CoValue depends on.
   * We currently track dependencies for:
   * - Ownership (a CoValue depends on its account/group owner)
   * - Group membership (a group depends on its direct account/group members)
   * - Sessions (a CoValue depends on Accounts that made changes to it)
   * - Branches (a branched CoValue depends on its branch source)
   * See {@link dependant} for the CoValues that depend on this CoValue.
   */
  dependencies: Set<RawCoID> = new Set();
  incompleteDependencies: Set<RawCoID> = new Set();
  private addDependency(dependency: RawCoID) {
    const dependencyCoValue = this.node.getCoValue(dependency);

    if (
      this.isCircularDependency(dependencyCoValue) ||
      this.dependencies.has(dependency)
    ) {
      return;
    }

    this.dependencies.add(dependency);
    dependencyCoValue.addDependant(this.id);

    if (!dependencyCoValue.isCompletelyDownloaded()) {
      this.incompleteDependencies.add(dependencyCoValue.id);
      dependencyCoValue.waitFor({
        predicate: (dependencyCoValue) =>
          dependencyCoValue.isCompletelyDownloaded(),
        onSuccess: () => {
          this.incompleteDependencies.delete(dependencyCoValue.id);
          if (this.incompleteDependencies.size === 0) {
            // We want this to propagate immediately in the dependency chain
            this.notifyUpdate();
          }
        },
      });
    }

    if (!dependencyCoValue.isAvailable()) {
      this.missingDependencies.add(dependencyCoValue.id);
      dependencyCoValue.waitFor({
        predicate: (dependencyCoValue) => dependencyCoValue.isAvailable(),
        onSuccess: () => {
          this.missingDependencies.delete(dependencyCoValue.id);

          if (this.missingDependencies.size === 0) {
            this.notifyUpdate(); // We want this to propagate immediately
          }
        },
      });
    }
  }

  /**
   * The CoValues that depend on this CoValue.
   * This is the inverse relationship of {@link dependencies}.
   */
  dependant: Set<RawCoID> = new Set();
  private addDependant(dependant: RawCoID) {
    this.dependant.add(dependant);
  }

  isGroupOrAccount() {
    if (!this.verified) {
      return false;
    }

    return this.verified.header.ruleset.type === "group";
  }

  isGroup() {
    if (!this.verified) {
      return false;
    }

    if (this.verified.header.ruleset.type !== "group") {
      return false;
    }

    if (this.verified.header.meta?.type === "account") {
      return false;
    }

    return true;
  }

  createBranch(name: string, ownerId?: RawCoID) {
    return createBranch(this, name, ownerId);
  }

  mergeBranch() {
    return mergeBranch(this);
  }

  getBranch(name: string, ownerId?: RawCoID) {
    return this.node.getCoValue(getBranchId(this, name, ownerId));
  }

  getCurrentBranchName() {
    return this.verified?.branchName;
  }

  getCurrentBranchSourceId() {
    return this.verified?.branchSourceId;
  }

  isBranched() {
    return Boolean(this.verified?.branchSourceId);
  }

  hasBranch(name: string, ownerId?: RawCoID) {
    // This function requires the meta information to be parsed, which might not be the case
    // if the value content hasn't been loaded yet
    this.parseNewTransactions(false);

    const currentOwnerId = getBranchOwnerId(this);
    return this.branches.some((item) => {
      if (item.branch !== name) {
        return false;
      }

      if (item.ownerId === ownerId) {
        return true;
      }

      if (!ownerId) {
        return item.ownerId === currentOwnerId;
      }

      if (!item.ownerId) {
        return ownerId === currentOwnerId;
      }
    });
  }

  getMergeCommits() {
    return this.mergeCommits;
  }

  getValidSortedTransactions(options?: {
    ignorePrivateTransactions: boolean;

    // The transactions that have already been processed, used for the incremental builds of the content views
    knownTransactions?: Record<RawCoID, number>;

    // Whether to include invalid transactions in the result (only transactions invalidated by metadata parsing are included e.g. init transactions)
    includeInvalidMetaTransactions?: boolean;
  }): DecryptedTransaction[] {
    const allTransactions = this.getValidTransactions(options);

    allTransactions.sort(this.compareTransactions);

    return allTransactions;
  }

  compareTransactions(
    a: Pick<VerifiedTransaction, "madeAt" | "txID">,
    b: Pick<VerifiedTransaction, "madeAt" | "txID">,
  ) {
    if (a.madeAt !== b.madeAt) {
      return a.madeAt - b.madeAt;
    }

    if (a.txID.sessionID === b.txID.sessionID) {
      return a.txID.txIndex - b.txID.txIndex;
    }

    return 0;
  }

  getCurrentReadKey(): {
    secret: KeySecret | undefined;
    id: KeyID;
  } {
    if (!this.verified) {
      throw new Error(
        "CoValueCore: getCurrentReadKey called on coValue without verified state",
      );
    }

    if (this.isGroupOrAccount()) {
      return expectGroup(this.getCurrentContent()).getCurrentReadKey();
    } else if (this.verified.header.ruleset.type === "ownedByGroup") {
      return this.node
        .expectCoValueLoaded(this.verified.header.ruleset.group)
        .getCurrentReadKey();
    } else {
      throw new Error(
        "Only groups or values owned by groups have read secrets",
      );
    }
  }

  readKeyCache = new Map<KeyID, KeySecret>();
  getReadKey(keyID: KeyID): KeySecret | undefined {
    // We want to check the cache here, to skip re-computing the group content
    const cachedSecret = this.readKeyCache.get(keyID);

    if (cachedSecret) {
      return cachedSecret;
    }

    if (!this.verified) {
      throw new Error(
        "CoValueCore: getUncachedReadKey called on coValue without verified state",
      );
    }

    if (this.isGroup()) {
      // is group
      const content = expectGroup(
        // Private transactions are not considered valid in groups, so we don't need to pass
        // ignorePrivateTransactions: true to safely load the content
        this.getCurrentContent(),
      );

      return content.getReadKey(keyID);
    } else if (this.isGroupOrAccount()) {
      // is account
      const content = expectGroup(
        // Old accounts might have private transactions, because we were encrypting the root id in the past
        // So we need to load the account without private transactions, because we can't decrypt them without the read key
        this.getCurrentContent({ ignorePrivateTransactions: true }),
      );

      return content.getReadKey(keyID);
    } else if (this.verified.header.ruleset.type === "ownedByGroup") {
      // is a CoValue owned by a group
      return expectGroup(
        this.node
          .expectCoValueLoaded(this.verified.header.ruleset.group)
          .getCurrentContent(),
      ).getReadKey(keyID);
    } else {
      throw new Error(
        "Only groups or values owned by groups have read secrets",
      );
    }
  }

  safeGetGroup(): RawGroup | undefined {
    if (!this.verified) {
      throw new Error(
        "CoValueCore: getGroup called on coValue without verified state",
      );
    }

    if (this.verified.header.ruleset.type !== "ownedByGroup") {
      return undefined;
    }

    return expectGroup(
      this.node
        .expectCoValueLoaded(this.verified.header.ruleset.group)
        .getCurrentContent(),
    );
  }

  getGroup(): RawGroup {
    const group = this.safeGetGroup();

    if (!group) {
      throw new Error("Only values owned by groups have groups");
    }

    return group;
  }

  getTx(txID: TransactionID): Transaction | undefined {
    return this.verified?.getSession(txID.sessionID)?.transactions[
      txID.txIndex
    ];
  }

  getDependedOnCoValues(): Set<RawCoID> {
    return this.dependencies;
  }

  waitForSync(options?: { timeout?: number }) {
    return this.node.syncManager.waitForSync(this.id, options?.timeout);
  }

  load(peers: PeerState[], mode?: LoadMode) {
    this.loadFromStorage((found) => {
      // When found the load is triggered by handleNewContent
      if (!found) {
        this.loadFromPeers(peers, mode);
      }
    });
  }

  loadFromStorage(done?: (found: boolean) => void) {
    const node = this.node;

    if (!node.storage) {
      done?.(false);
      return;
    }

    const currentState = this.getLoadingStateForPeer("storage");

    if (currentState === "pending") {
      if (!done) {
        // We don't need to notify the result to anyone, so we can return early
        return;
      }

      // Loading the value
      this.subscribe((state, unsubscribe) => {
        const updatedState = state.getLoadingStateForPeer("storage");

        if (updatedState === "available" || state.isAvailable()) {
          unsubscribe();
          done(true);
        } else if (
          updatedState === "errored" ||
          updatedState === "unavailable"
        ) {
          unsubscribe();
          done(false);
        }
      });
      return;
    }

    // Check if we need to load from storage:
    // - If storage state is not unknown (already tried), AND
    // - Overall state is not garbageCollected/onlyKnownState (which need full content)
    // Then return early
    const overallState = this.loadingState;
    if (
      currentState !== "unknown" &&
      overallState !== "garbageCollected" &&
      overallState !== "onlyKnownState"
    ) {
      done?.(currentState === "available");
      return;
    }

    this.markPending("storage");
    node.storage.load(
      this.id,
      (data) => {
        node.syncManager.handleNewContent(data, "storage");
      },
      (found) => {
        done?.(found);

        if (!found) {
          this.markNotFoundInPeer("storage");
        }
      },
    );
  }

  /**
   * Lazily load only the knownState from storage without loading full transaction data.
   * This is useful for checking if a peer needs new content before committing to a full load.
   *
   * If found in storage, marks the CoValue as onlyKnownState and caches the knownState.
   * This enables accurate LOAD requests during peer reconciliation.
   *
   * @param done - Callback with the storage knownState, or undefined if not found in storage
   */
  getKnownStateFromStorage(
    done: (knownState: CoValueKnownState | undefined) => void,
  ) {
    if (!this.node.storage) {
      done(undefined);
      return;
    }

    // If we already have knowledge about this CoValue (in memory or cached), return it
    // knownState() returns verified state, lastKnownState, or empty state
    const knownState = this.knownState();
    if (knownState.header) {
      done(knownState);
      return;
    }

    // Delegate to storage - caching is handled at storage level
    this.node.storage.loadKnownState(this.id, (knownState) => {
      // The coValue could become available in the meantime.
      if (knownState && !this.isAvailable()) {
        // Cache the knownState and mark as onlyKnownState
        const previousState = this.loadingState;
        this.#lastKnownStateSource = "onlyKnownState";
        this.#lastKnownState = knownState;
        this.updateCounter(previousState);
      }
      done(knownState);
    });
  }

  loadFromPeers(peers: PeerState[], mode?: LoadMode) {
    if (peers.length === 0) {
      return;
    }

    for (const peer of peers) {
      const currentState = this.getLoadingStateForPeer(peer.id);

      if (currentState === "unknown" || currentState === "unavailable") {
        this.markPending(peer.id);
        this.internalLoadFromPeer(peer, mode);
      }
    }
  }

  private internalLoadFromPeer(peer: PeerState, mode?: LoadMode) {
    if (peer.closed && !peer.persistent) {
      this.markNotFoundInPeer(peer.id);
      return;
    }

    let persistentCloseTimer: ReturnType<typeof setTimeout> | undefined;
    const markNotFound = () => {
      if (this.getLoadingStateForPeer(peer.id) === "pending") {
        logger.warn("Timeout waiting for peer to load coValue", {
          id: this.id,
          peerID: peer.id,
        });
        this.markNotFoundInPeer(peer.id);
      }
    };

    const clearPersistentCloseTimer = () => {
      if (persistentCloseTimer) {
        clearTimeout(persistentCloseTimer);
        persistentCloseTimer = undefined;
      }
    };

    const schedulePersistentPeerGraceTimeout = () => {
      clearPersistentCloseTimer();
      persistentCloseTimer = setTimeout(() => {
        // If the peer with the same id reconnected, avoid marking it as unavailable.
        const currentPeer = this.node.syncManager.peers[peer.id];
        if (currentPeer && !currentPeer.closed) {
          return;
        }
        markNotFound();
      }, CO_VALUE_LOADING_CONFIG.TIMEOUT);
    };

    // Non-persistent peers are considered unavailable immediately on close.
    // Persistent peers get a grace period to reconnect before being marked unavailable.
    const removeCloseListener = peer.addCloseListener(() => {
      if (!peer.persistent) {
        markNotFound();
        return;
      }
      schedulePersistentPeerGraceTimeout();
    });

    /**
     * On reconnection persistent peers will automatically fire the load request
     * as part of the reconnection process.
     */
    if (!peer.closed) {
      peer.sendLoadRequest(this, mode);
    } else if (peer.persistent) {
      schedulePersistentPeerGraceTimeout();
    }

    this.subscribe((state, unsubscribe) => {
      const peerState = state.getLoadingStateForPeer(peer.id);
      if (
        state.isAvailable() || // might have become available from another peer e.g. through handleNewContent
        peerState === "available" ||
        peerState === "errored" ||
        peerState === "unavailable"
      ) {
        unsubscribe();
        removeCloseListener();
        clearPersistentCloseTimer();
      }
    }, true);
  }
}

export type InvalidHashError = {
  type: "InvalidHash";
  id: RawCoID;
  expectedNewHash: Hash;
  givenExpectedNewHash: Hash;
};

export type InvalidSignatureError = {
  type: "InvalidSignature";
  id: RawCoID;
  newSignature: Signature;
  sessionID: SessionID;
  signerID: SignerID | undefined;
};

export type TriedToAddTransactionsWithoutVerifiedStateErrpr = {
  type: "TriedToAddTransactionsWithoutVerifiedState";
  id: RawCoID;
};

export type TriedToAddTransactionsWithoutSignerIDError = {
  type: "TriedToAddTransactionsWithoutSignerID";
  id: RawCoID;
  sessionID: SessionID;
};

export type DeleteTransactionRejectedError = {
  type: "DeleteTransactionRejected";
  id: RawCoID;
  sessionID: SessionID;
  author: RawAccountID | AgentID;
  reason: "NotAdmin" | "CoValueNotDeletable" | "CannotVerifyPermissions";
  error: Error;
};

export type TryAddTransactionsError =
  | TriedToAddTransactionsWithoutVerifiedStateErrpr
  | TriedToAddTransactionsWithoutSignerIDError
  | ResolveAccountAgentError
  | InvalidHashError
  | InvalidSignatureError
  | DeleteTransactionRejectedError;
