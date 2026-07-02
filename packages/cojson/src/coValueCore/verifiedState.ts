import { AnyRawCoValue } from "../coValue.js";
import {
  createContentMessage,
  exceedsRecommendedSize,
  getTransactionSize,
  addTransactionToContentMessage,
} from "../coValueContentMessage.js";
import {
  CryptoProvider,
  Encrypted,
  KeyID,
  KeySecret,
  Signature,
  SignerID,
  SessionMapImpl,
} from "../crypto/crypto.js";
import {
  isDeleteSessionID,
  RawCoID,
  SessionID,
  TransactionID,
} from "../ids.js";
import { Stringified, parseJSON } from "../jsonStringify.js";
import { JsonObject, JsonValue } from "../jsonValue.js";
import { PermissionsDef as RulesetDef } from "../permissions.js";
import { NewContentMessage, SessionNewContent } from "../sync.js";
import { ControlledAccountOrAgent } from "../coValues/account.js";
import {
  CoValueKnownState,
  getKnownStateToSend,
  KnownStateSessions,
} from "../knownState.js";
import { TRANSACTION_CONFIG } from "../config.js";

export type CoValueHeader = {
  type: AnyRawCoValue["type"];
  ruleset: RulesetDef;
  meta: JsonObject | null;
} & CoValueUniqueness;

export type CoValueUniqueness = {
  uniqueness: Uniqueness;
  createdAt?: `2${string}` | null;
};

export type Uniqueness =
  | string
  | boolean
  | null
  | undefined
  | {
      [key: string]: string;
    };

export type PrivateTransaction = {
  privacy: "private";
  madeAt: number;
  keyUsed: KeyID;
  encryptedChanges: Encrypted<JsonValue[], { in: RawCoID; tx: TransactionID }>;
  meta?: Encrypted<JsonObject, { in: RawCoID; tx: TransactionID }>;
};
export type TrustingTransaction = {
  privacy: "trusting";
  madeAt: number;
  changes: Stringified<JsonValue[]>;
  meta?: Stringified<JsonObject>;
};

export type Transaction = PrivateTransaction | TrustingTransaction;

export type SessionLog = {
  signerID?: SignerID;
  transactions: Transaction[];
  lastSignature: Signature | undefined;
  signatureAfter: { [txIdx: number]: Signature | undefined };
  sessionID: SessionID;
};

export class VerifiedState {
  readonly id: RawCoID;
  readonly crypto: CryptoProvider;
  readonly header: CoValueHeader;
  private readonly impl: SessionMapImpl;
  public lastAccessed: number | undefined;
  public branchSourceId?: RawCoID;
  public branchName?: string;
  private isDeleted: boolean = false;

  // Cache for SessionLog objects to avoid re-parsing on every access
  private sessionLogCache: Map<SessionID, SessionLog> = new Map();
  private sessionLogCacheValid: Map<SessionID, number> = new Map(); // txCount when cached

  // Cache for known state to avoid repeated FFI calls between mutations
  private cachedKnownState: CoValueKnownState | undefined;
  private cachedKnownStateWithStreaming: CoValueKnownState | undefined;

  constructor(
    id: RawCoID,
    crypto: CryptoProvider,
    header: CoValueHeader,
    streamingKnownState?: KnownStateSessions,
    skipVerify?: boolean,
  ) {
    this.id = id;
    this.crypto = crypto;
    this.header = header;
    this.branchSourceId = header.meta?.source as RawCoID | undefined;
    this.branchName = header.meta?.branch as string | undefined;

    this.impl = crypto.createSessionMap(
      id,
      JSON.stringify(header),
      TRANSACTION_CONFIG.MAX_RECOMMENDED_TX_SIZE,
      skipVerify,
    );

    // Set streaming known state if provided
    if (streamingKnownState) {
      this.impl.setStreamingKnownState(JSON.stringify(streamingKnownState));
    }
  }

  private invalidateCache() {
    this.sessionLogCache.clear();
    this.sessionLogCacheValid.clear();
    this.invalidateKnownStateCache();
  }

  private invalidateKnownStateCache() {
    this.cachedKnownState = undefined;
    this.cachedKnownStateWithStreaming = undefined;
  }

  /**
   * Update the session log cache directly when adding transactions.
   * This avoids round-trips to Rust on subsequent reads.
   */
  private updateSessionLogCache(
    sessionID: SessionID,
    signerID: SignerID | undefined,
    newTransactions: Transaction[],
    newSignature: Signature,
  ) {
    const cached = this.sessionLogCache.get(sessionID);
    const currentTxCount = this.impl.getTransactionCount(sessionID);

    if (cached) {
      // Append to existing cache
      for (const tx of newTransactions) {
        cached.transactions.push(tx);
      }
      cached.lastSignature = newSignature;
      if (signerID) {
        cached.signerID = signerID;
      }
      // Check if we need to update signatureAfter (in-between signature)
      this.updateLastCheckpointSignature(sessionID, cached.signatureAfter);
      this.sessionLogCacheValid.set(sessionID, currentTxCount);
    } else {
      // Create new cache entry
      const signatureAfter: { [txIdx: number]: Signature | undefined } = {};
      this.updateLastCheckpointSignature(sessionID, signatureAfter);
      const sessionLog: SessionLog = {
        signerID,
        transactions: newTransactions.slice(),
        lastSignature: newSignature,
        signatureAfter,
        sessionID,
      };
      this.sessionLogCache.set(sessionID, sessionLog);
      this.sessionLogCacheValid.set(sessionID, currentTxCount);
    }
  }

  /**
   * Update the signatureAfter map with the latest checkpoint signature.
   * Used when updating cache incrementally.
   */
  private updateLastCheckpointSignature(
    sessionID: SessionID,
    signatureAfter: { [txIdx: number]: Signature | undefined },
  ): void {
    const lastCheckpoint = this.impl.getLastSignatureCheckpoint(sessionID);
    if (
      lastCheckpoint !== undefined &&
      lastCheckpoint !== null &&
      lastCheckpoint >= 0
    ) {
      const sig = this.impl.getSignatureAfter(sessionID, lastCheckpoint);
      if (sig) {
        signatureAfter[lastCheckpoint] = sig as Signature;
      }
    }
  }

  /**
   * Build the signatureAfter map for a session by iterating through all checkpoints.
   * Used when building a fresh SessionLog from Rust data.
   */
  private buildSignatureAfterMap(sessionID: SessionID): {
    [txIdx: number]: Signature | undefined;
  } {
    const signatureAfter: { [txIdx: number]: Signature | undefined } = {};
    const lastCheckpoint = this.impl.getLastSignatureCheckpoint(sessionID);
    if (
      lastCheckpoint !== undefined &&
      lastCheckpoint !== null &&
      lastCheckpoint >= 0
    ) {
      for (let i = 0; i <= lastCheckpoint; i++) {
        const sig = this.impl.getSignatureAfter(sessionID, i);
        if (sig) {
          signatureAfter[i] = sig as Signature;
        }
      }
    }
    return signatureAfter;
  }

  private getSessionLog(sessionID: SessionID): SessionLog {
    const currentTxCount = this.impl.getTransactionCount(sessionID);
    const cachedTxCount = this.sessionLogCacheValid.get(sessionID);

    // Check if cache is valid
    if (cachedTxCount === currentTxCount) {
      const cached = this.sessionLogCache.get(sessionID);
      if (cached) return cached;
    }

    // Fetch all transactions from Rust
    const transactions: Transaction[] =
      currentTxCount > 0
        ? (this.impl.getSessionTransactions(sessionID, 0) ?? [])
        : [];

    // Build signatureAfter map
    const signatureAfter = this.buildSignatureAfterMap(sessionID);

    const lastSignature = this.impl.getLastSignature(sessionID) as
      | Signature
      | undefined;

    const sessionLog: SessionLog = {
      signerID: undefined, // We don't track this in Rust currently
      transactions,
      lastSignature,
      signatureAfter,
      sessionID,
    };

    // Cache the result
    this.sessionLogCache.set(sessionID, sessionLog);
    this.sessionLogCacheValid.set(sessionID, currentTxCount);

    return sessionLog;
  }

  markAsDeleted() {
    this.isDeleted = true;
    this.impl.markAsDeleted();
    this.invalidateCache();
  }

  tryAddTransactions(
    sessionID: SessionID,
    signerID: SignerID | undefined,
    newTransactions: Transaction[],
    newSignature: Signature,
    skipVerify: boolean = false,
  ) {
    if (this.isDeleted && !isDeleteSessionID(sessionID)) {
      throw new Error("Cannot add transactions to a deleted coValue");
    }

    // Convert transactions to JSON array
    const txJson = JSON.stringify(newTransactions);

    this.impl.addTransactions(
      sessionID,
      signerID,
      txJson,
      newSignature,
      skipVerify,
    );

    // Update cache directly instead of invalidating
    this.updateSessionLogCache(
      sessionID,
      signerID,
      newTransactions,
      newSignature,
    );
    this.invalidateKnownStateCache();
  }

  makeNewTrustingTransaction(
    sessionID: SessionID,
    signerAgent: ControlledAccountOrAgent,
    changes: JsonValue[],
    meta: JsonObject | undefined,
    madeAt: number,
  ): { signature: Signature; transaction: Transaction } {
    if (this.isDeleted) {
      throw new Error(
        "Cannot make new trusting transaction on a deleted coValue",
      );
    }

    const changesJson = JSON.stringify(changes);
    const metaJson = meta ? JSON.stringify(meta) : undefined;
    const signerSecret = signerAgent.currentSignerSecret();

    const resultJson = this.impl.makeNewTrustingTransaction(
      sessionID,
      signerSecret,
      changesJson,
      metaJson,
      madeAt,
    );

    const result = JSON.parse(resultJson) as {
      signature: string;
      transaction: Transaction;
    };

    const signature = result.signature as Signature;

    // Update cache directly instead of invalidating
    this.updateSessionLogCache(
      sessionID,
      signerAgent.id as unknown as SignerID,
      [result.transaction],
      signature,
    );
    this.invalidateKnownStateCache();

    return {
      signature,
      transaction: result.transaction,
    };
  }

  makeNewPrivateTransaction(
    sessionID: SessionID,
    signerAgent: ControlledAccountOrAgent,
    changes: JsonValue[],
    keyID: KeyID,
    keySecret: KeySecret,
    meta: JsonObject | undefined,
    madeAt: number,
  ): { signature: Signature; transaction: Transaction } {
    if (this.isDeleted) {
      throw new Error(
        "Cannot make new private transaction on a deleted coValue",
      );
    }

    const changesJson = JSON.stringify(changes);
    const metaJson = meta ? JSON.stringify(meta) : undefined;
    const signerSecret = signerAgent.currentSignerSecret();

    const resultJson = this.impl.makeNewPrivateTransaction(
      sessionID,
      signerSecret,
      changesJson,
      keyID,
      keySecret,
      metaJson,
      madeAt,
    );

    const result = JSON.parse(resultJson) as {
      signature: string;
      transaction: Transaction;
    };

    const signature = result.signature as Signature;

    // Update cache directly instead of invalidating
    this.updateSessionLogCache(
      sessionID,
      signerAgent.id as unknown as SignerID,
      [result.transaction],
      signature,
    );
    this.invalidateKnownStateCache();

    return {
      signature,
      transaction: result.transaction,
    };
  }

  setStreamingKnownState(streamingKnownState: KnownStateSessions) {
    if (this.isDeleted) {
      return;
    }
    this.impl.setStreamingKnownState(JSON.stringify(streamingKnownState));
    this.cachedKnownStateWithStreaming = undefined;
  }

  getSession(sessionID: SessionID): SessionLog | undefined {
    const txCount = this.impl.getTransactionCount(sessionID);
    if (txCount === -1) {
      return undefined;
    }
    return this.getSessionLog(sessionID);
  }

  getFullSessionContent(sessionID: SessionID): SessionNewContent[] {
    const session = this.getSession(sessionID);

    if (
      !session ||
      session.transactions.length === 0 ||
      session.lastSignature === undefined
    ) {
      return [];
    }

    const content: SessionNewContent[] = [];
    let after = 0;
    let pieceTransactions: Transaction[] = [];

    for (let txIdx = 0; txIdx < session.transactions.length; txIdx++) {
      const tx = session.transactions[txIdx]!;

      pieceTransactions.push(tx);

      const signatureAfter = session.signatureAfter[txIdx];

      if (signatureAfter) {
        content.push({
          after,
          newTransactions: pieceTransactions,
          lastSignature: signatureAfter,
        });
        after += pieceTransactions.length;
        pieceTransactions = [];
      }
    }

    if (pieceTransactions.length > 0 && session.lastSignature) {
      content.push({
        after,
        newTransactions: pieceTransactions,
        lastSignature: session.lastSignature,
      });
    }

    return content;
  }

  getTransactionsCount(sessionID: SessionID): number | undefined {
    const txCount = this.impl.getTransactionCount(sessionID);
    if (txCount === -1) {
      return undefined;
    }
    return txCount;
  }

  get sessionCount(): number {
    return this.impl.getSessionIds().length;
  }

  getSessions(): Map<SessionID, SessionLog> {
    // Build a Map from all sessions
    const map = new Map<SessionID, SessionLog>();
    const sessionIds = this.impl.getSessionIds() as SessionID[];
    for (const sessionID of sessionIds) {
      map.set(sessionID, this.getSessionLog(sessionID));
    }
    return map;
  }

  *sessionEntries(): IterableIterator<[SessionID, SessionLog]> {
    const sessionIds = this.impl.getSessionIds() as SessionID[];
    for (const sessionID of sessionIds) {
      yield [sessionID, this.getSessionLog(sessionID)];
    }
  }

  newContentSince(
    knownState: CoValueKnownState | undefined,
  ): NewContentMessage[] | undefined {
    let currentPiece: NewContentMessage = createContentMessage(
      this.id,
      this.header,
      false,
    );
    const pieces: NewContentMessage[] = [currentPiece];
    let pieceSize = 0;

    const startNewPiece = () => {
      currentPiece = createContentMessage(this.id, this.header, false);
      pieces.push(currentPiece);
      pieceSize = 0;
    };

    const moveSessionContentToNewPiece = (sessionID: SessionID) => {
      const sessionContent = currentPiece.new[sessionID];

      if (!sessionContent) {
        throw new Error("Session content not found", {
          cause: {
            sessionID,
            currentPiece,
          },
        });
      }

      delete currentPiece.new[sessionID];

      const newPiece = createContentMessage(this.id, this.header, false);
      newPiece.new[sessionID] = sessionContent;

      // Insert the new piece before the current piece, to ensure that the order of the new transactions is preserved
      pieces.splice(pieces.length - 1, 0, newPiece);
    };

    const sessionSent = knownState?.sessions;

    for (const [sessionID, log] of this.getSessions()) {
      if (this.isDeleted && !isDeleteSessionID(sessionID)) {
        continue;
      }

      const startFrom = sessionSent?.[sessionID] ?? 0;

      let currentSessionSize = 0;

      for (let txIdx = startFrom; txIdx < log.transactions.length; txIdx++) {
        const isLastItem = txIdx === log.transactions.length - 1;
        const tx = log.transactions[txIdx]!;

        currentSessionSize += getTransactionSize(tx);

        const signatureAfter = log.signatureAfter[txIdx];

        if (signatureAfter) {
          addTransactionToContentMessage(
            currentPiece,
            tx,
            sessionID,
            signatureAfter,
            txIdx,
          );
          // When we meet a signatureAfter it means that the transaction log exceeds the recommended size
          // so we move the session content to a dedicated piece, because it must be sent in a standalone piece
          moveSessionContentToNewPiece(sessionID);
          currentSessionSize = 0;
        } else if (isLastItem) {
          if (!log.lastSignature) {
            throw new Error(
              "All the SessionLogs sent must have a lastSignature",
              {
                cause: log,
              },
            );
          }

          addTransactionToContentMessage(
            currentPiece,
            tx,
            sessionID,
            log.lastSignature,
            txIdx,
          );

          // If the current session size already exceeds the recommended size, we move the session content to a dedicated piece
          if (exceedsRecommendedSize(currentSessionSize)) {
            assertLastSignature(sessionID, currentPiece);
            moveSessionContentToNewPiece(sessionID);
          } else if (exceedsRecommendedSize(pieceSize, currentSessionSize)) {
            assertLastSignature(sessionID, currentPiece);
            startNewPiece();
          } else {
            pieceSize += currentSessionSize;
          }
        } else {
          // Unsafely add the transaction to the content message, without a signature because we don't have one for this session
          // Checks and assertions are enforced in this function to avoid that a content message gets out without a signature
          const signature = undefined as Signature | undefined;
          addTransactionToContentMessage(
            currentPiece,
            tx,
            sessionID,
            signature!,
            txIdx,
          );
        }
      }

      assertLastSignature(sessionID, currentPiece);
    }

    const firstPiece = pieces[0];

    if (!firstPiece) {
      throw new Error("First piece not found", {
        cause: pieces,
      });
    }

    const includeHeader = !knownState?.header;

    if (includeHeader) {
      firstPiece.header = this.header;
    }

    const piecesWithContent = pieces.filter(
      (piece) => piece.header || Object.keys(piece.new).length > 0,
    );

    if (piecesWithContent.length > 1 || this.isStreaming()) {
      if (knownState) {
        firstPiece.expectContentUntil = getKnownStateToSend(
          this.knownStateWithStreaming().sessions,
          knownState.sessions,
        );
      } else {
        firstPiece.expectContentUntil = {
          ...this.knownStateWithStreaming().sessions,
        };
      }
    }

    if (piecesWithContent.length === 0) {
      return undefined;
    }

    return piecesWithContent;
  }

  knownState(): CoValueKnownState {
    if (!this.cachedKnownState) {
      this.cachedKnownState = this.impl.getKnownState() as CoValueKnownState;
    }
    return this.cachedKnownState;
  }

  knownStateWithStreaming(): CoValueKnownState {
    if (!this.cachedKnownStateWithStreaming) {
      const result = this.impl.getKnownStateWithStreaming();
      if (!result || result === undefined) {
        this.cachedKnownStateWithStreaming = this.knownState();
      } else {
        this.cachedKnownStateWithStreaming = result as CoValueKnownState;
      }
    }
    return this.cachedKnownStateWithStreaming;
  }

  isStreaming(): boolean {
    return this.impl.isStreaming();
  }

  decryptTransaction(
    sessionID: SessionID,
    txIndex: number,
    keySecret: KeySecret,
  ): JsonValue[] | undefined {
    const decrypted = this.impl.decryptTransaction(
      sessionID,
      txIndex,
      keySecret,
    );
    if (!decrypted) {
      return undefined;
    }
    return parseJSON(decrypted as Stringified<JsonValue[]>);
  }

  decryptTransactionMeta(
    sessionID: SessionID,
    txIndex: number,
    keySecret: KeySecret,
  ): JsonObject | undefined {
    const sessionLog = this.getSession(sessionID);
    if (!sessionLog?.transactions[txIndex]?.meta) {
      return undefined;
    }
    const decrypted = this.impl.decryptTransactionMeta(
      sessionID,
      txIndex,
      keySecret,
    );
    if (!decrypted) {
      return undefined;
    }
    return parseJSON(decrypted as Stringified<JsonObject>);
  }
}

function assertLastSignature(sessionID: SessionID, content: NewContentMessage) {
  if (content.new[sessionID] && !content.new[sessionID].lastSignature) {
    throw new Error("The SessionContent sent must have a lastSignature", {
      cause: content.new[sessionID],
    });
  }
}
