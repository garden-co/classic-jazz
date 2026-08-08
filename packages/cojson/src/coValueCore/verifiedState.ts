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
import { Stringified, parseJSON, safeParseJSON } from "../jsonStringify.js";
import { JsonObject, JsonValue } from "../jsonValue.js";
import { PermissionsDef as RulesetDef } from "../permissions.js";
import { NewContentMessage } from "../sync.js";
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
    const txJson = stringifyTransactions(newTransactions);

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

  /**
   * Batch-decrypt private transactions. Element i corresponds to
   * txIndices[i]; undefined entries failed to decrypt. Uses the native batch
   * fast path when available, transparently falling back to per-transaction
   * decryptTransaction otherwise.
   */
  decryptTransactionsBatch(
    sessionID: SessionID,
    txIndices: number[],
    keySecret: KeySecret,
  ): (JsonValue[] | undefined)[] {
    // Per-transaction fallback matching the batch's per-tx-failure semantics:
    // each failed/throwing transaction becomes undefined.
    const perTransactionFallback = (): (JsonValue[] | undefined)[] =>
      txIndices.map((txIndex) => {
        try {
          return this.decryptTransaction(sessionID, txIndex, keySecret);
        } catch {
          return undefined;
        }
      });

    const batch = this.impl.decryptTransactions;
    if (!batch) {
      return perTransactionFallback();
    }

    const combined = batch.call(
      this.impl,
      sessionID,
      Uint32Array.from(txIndices),
      keySecret,
    );

    if (combined === undefined) {
      return perTransactionFallback();
    }

    // Corrupt combined plaintext parses to undefined: fall back per-tx.
    const parsed = safeParseJSON(
      combined as Stringified<(JsonValue[] | null)[]>,
    );

    if (!Array.isArray(parsed) || parsed.length !== txIndices.length) {
      return perTransactionFallback();
    }

    return (parsed as (JsonValue[] | null)[]).map((entry) =>
      entry == null ? undefined : entry,
    );
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

// Matches characters that JSON.stringify would escape (or that would make a
// naively quoted string invalid JSON): quotes, backslashes, control
// characters and surrogates.
const NEEDS_JSON_ESCAPING = new RegExp('["\\\\\\u0000-\\u001f\\ud800-\\udfff]');

/**
 * Serialize a JSON string value. Fast path for strings that need no escaping
 * (the common case: base64url-encoded transaction payloads), falling back to
 * JSON.stringify otherwise. Output is always byte-identical to JSON.stringify.
 */
function jsonString(value: string): string {
  return NEEDS_JSON_ESCAPING.test(value) ? JSON.stringify(value) : `"${value}"`;
}

/**
 * Serialize transactions for the native SessionMap.
 *
 * Equivalent to JSON.stringify(transactions), but avoids JSON.stringify's
 * escape scanning for the large (base64url, escape-free) payload strings,
 * which dominates the cost of importing large CoValues. The native side
 * re-canonicalizes transactions before hashing, so only value equality with
 * JSON.stringify matters here.
 */
export function stringifyTransactions(transactions: Transaction[]): string {
  const parts: string[] = [];
  for (const tx of transactions) {
    if (
      tx.privacy === "private" &&
      typeof tx.encryptedChanges === "string" &&
      typeof tx.keyUsed === "string" &&
      typeof tx.madeAt === "number" &&
      (tx.meta === undefined || typeof tx.meta === "string")
    ) {
      parts.push(
        `{"encryptedChanges":${jsonString(tx.encryptedChanges)},"keyUsed":${jsonString(tx.keyUsed)},"madeAt":${tx.madeAt}${
          tx.meta === undefined ? "" : `,"meta":${jsonString(tx.meta)}`
        },"privacy":"private"}`,
      );
    } else if (
      tx.privacy === "trusting" &&
      typeof tx.changes === "string" &&
      typeof tx.madeAt === "number" &&
      (tx.meta === undefined || typeof tx.meta === "string")
    ) {
      parts.push(
        `{"changes":${jsonString(tx.changes)},"madeAt":${tx.madeAt}${
          tx.meta === undefined ? "" : `,"meta":${jsonString(tx.meta)}`
        },"privacy":"trusting"}`,
      );
    } else {
      // Unexpected shape: keep the generic (previous) behavior
      parts.push(JSON.stringify(tx));
    }
  }
  const out = `[${parts.join(",")}]`;
  // Force V8 to flatten the rope built by the concatenations above: the
  // wasm-bindgen string-passing glue reads via charCodeAt, which is
  // pathologically slow on unflattened cons strings.
  out.indexOf("\u0000");
  return out;
}

function assertLastSignature(sessionID: SessionID, content: NewContentMessage) {
  if (content.new[sessionID] && !content.new[sessionID].lastSignature) {
    throw new Error("The SessionContent sent must have a lastSignature", {
      cause: content.new[sessionID],
    });
  }
}
