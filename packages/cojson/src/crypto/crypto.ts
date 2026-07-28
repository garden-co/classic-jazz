import { base58 } from "@scure/base";
import { RawAccountID } from "../coValues/account.js";
import {
  AgentID,
  RawCoID,
  TransactionID,
  ActiveSessionID,
  DeleteSessionID,
} from "../ids.js";
import { Stringified, parseJSON, stableStringify } from "../jsonStringify.js";
import { JsonValue } from "../jsonValue.js";
import { logger } from "../logger.js";
import { Transaction } from "../coValueCore/verifiedState.js";

function randomBytes(bytesLength = 32): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(bytesLength));
}

export type SignerSecret = `signerSecret_z${string}`;
export type SignerID = `signer_z${string}`;
export type Signature = `signature_z${string}`;

export type SealerSecret = `sealerSecret_z${string}`;
export type SealerID = `sealer_z${string}`;
export type Sealed<T> = `sealed_U${string}` & { __type: T };
// Anonymous box - encrypted to a group's sealer without sender authentication
export type SealedForGroup<T> = `sealedForGroup_U${string}` & { __type: T };

export type AgentSecret = `${SealerSecret}/${SignerSecret}`;

export const textEncoder = new TextEncoder();
export const textDecoder = new TextDecoder();

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export abstract class CryptoProvider<Blake3State = any> {
  randomBytes(length: number): Uint8Array {
    return randomBytes(length);
  }

  abstract newEd25519SigningKey(): Uint8Array;

  newRandomSigner(): SignerSecret {
    return `signerSecret_z${base58.encode(this.newEd25519SigningKey())}`;
  }

  abstract getSignerID(secret: SignerSecret): SignerID;

  abstract sign(secret: SignerSecret, message: JsonValue): Signature;

  abstract verify(
    signature: Signature,
    message: JsonValue,
    id: SignerID,
  ): boolean;

  abstract newX25519StaticSecret(): Uint8Array;

  newRandomSealer(): SealerSecret {
    return `sealerSecret_z${base58.encode(this.newX25519StaticSecret())}`;
  }

  abstract getSealerID(secret: SealerSecret): SealerID;

  newRandomAgentSecret(): AgentSecret {
    return `${this.newRandomSealer()}/${this.newRandomSigner()}`;
  }

  agentIdCache = new Map<string, AgentID>();
  getAgentID(secret: AgentSecret): AgentID {
    const cacheKey = secret;
    let agentId = this.agentIdCache.get(cacheKey);
    if (!agentId) {
      const [sealerSecret, signerSecret] = secret.split("/") as [
        SealerSecret,
        SignerSecret,
      ];
      agentId = `${this.getSealerID(sealerSecret)}/${this.getSignerID(signerSecret)}`;
      this.agentIdCache.set(cacheKey, agentId);
    }
    return agentId;
  }

  getAgentSignerID(agentId: AgentID): SignerID {
    return agentId.split("/")[1] as SignerID;
  }

  getAgentSignerSecret(agentSecret: AgentSecret): SignerSecret {
    return agentSecret.split("/")[1] as SignerSecret;
  }

  getAgentSealerID(agentId: AgentID): SealerID {
    return agentId.split("/")[0] as SealerID;
  }

  getAgentSealerSecret(agentSecret: AgentSecret): SealerSecret {
    return agentSecret.split("/")[0] as SealerSecret;
  }

  abstract blake3HashOnce(data: Uint8Array): Uint8Array;
  abstract blake3HashOnceWithContext(
    data: Uint8Array,
    { context }: { context: Uint8Array },
  ): Uint8Array;

  secureHash(value: JsonValue): Hash {
    return `hash_z${base58.encode(
      this.blake3HashOnce(textEncoder.encode(stableStringify(value))),
    )}`;
  }

  abstract shortHash(value: JsonValue): ShortHash;

  abstract encrypt<T extends JsonValue, N extends JsonValue>(
    value: T,
    keySecret: KeySecret,
    nOnceMaterial: N,
  ): Encrypted<T, N>;

  abstract decryptRaw<T extends JsonValue, N extends JsonValue>(
    encrypted: Encrypted<T, N>,
    keySecret: KeySecret,
    nOnceMaterial: N,
  ): Stringified<T>;

  decrypt<T extends JsonValue, N extends JsonValue>(
    encrypted: Encrypted<T, N>,
    keySecret: KeySecret,
    nOnceMaterial: N,
  ): T | undefined {
    try {
      return parseJSON(this.decryptRaw(encrypted, keySecret, nOnceMaterial));
    } catch (e) {
      logger.error("Decryption error", { err: e });
      return undefined;
    }
  }

  newRandomKeySecret(): { secret: KeySecret; id: KeyID } {
    return {
      secret: `keySecret_z${base58.encode(this.randomBytes(32))}`,
      id: `key_z${base58.encode(this.randomBytes(12))}`,
    };
  }

  encryptKeySecret(keys: {
    toEncrypt: { id: KeyID; secret: KeySecret };
    encrypting: { id: KeyID; secret: KeySecret };
  }): {
    encryptedID: KeyID;
    encryptingID: KeyID;
    encrypted: Encrypted<
      KeySecret,
      { encryptedID: KeyID; encryptingID: KeyID }
    >;
  } {
    const nOnceMaterial = {
      encryptedID: keys.toEncrypt.id,
      encryptingID: keys.encrypting.id,
    };

    return {
      encryptedID: keys.toEncrypt.id,
      encryptingID: keys.encrypting.id,
      encrypted: this.encrypt(
        keys.toEncrypt.secret,
        keys.encrypting.secret,
        nOnceMaterial,
      ),
    };
  }

  decryptKeySecret(
    encryptedInfo: {
      encryptedID: KeyID;
      encryptingID: KeyID;
      encrypted: Encrypted<
        KeySecret,
        { encryptedID: KeyID; encryptingID: KeyID }
      >;
    },
    sealingSecret: KeySecret,
  ): KeySecret | undefined {
    const nOnceMaterial = {
      encryptedID: encryptedInfo.encryptedID,
      encryptingID: encryptedInfo.encryptingID,
    };

    return this.decrypt(encryptedInfo.encrypted, sealingSecret, nOnceMaterial);
  }

  abstract seal<T extends JsonValue>({
    message,
    from,
    to,
    nOnceMaterial,
  }: {
    message: T;
    from: SealerSecret;
    to: SealerID;
    nOnceMaterial: { in: RawCoID; tx: TransactionID };
  }): Sealed<T>;

  abstract unseal<T extends JsonValue>(
    sealed: Sealed<T>,
    sealer: SealerSecret,
    from: SealerID,
    nOnceMaterial: { in: RawCoID; tx: TransactionID },
  ): T | undefined;

  // Derive group sealer deterministically from read key
  // This ensures concurrent migrations by different admins produce the same result
  groupSealerFromReadKey(readKeySecret: KeySecret): {
    publicKey: SealerID;
    secret: SealerSecret;
  } {
    const sealerBytes = this.blake3HashOnceWithContext(
      textEncoder.encode(readKeySecret),
      { context: textEncoder.encode("groupSealer") },
    );
    // Blake3 output must be exactly 32 bytes to match X25519 secret key length
    if (sealerBytes.length !== 32) {
      throw new Error(
        `Blake3 output must be 32 bytes for X25519 key, got ${sealerBytes.length}`,
      );
    }
    const secret: SealerSecret = `sealerSecret_z${base58.encode(sealerBytes)}`;
    return {
      secret,
      publicKey: this.getSealerID(secret),
    };
  }

  // Anonymous box - encrypt data to a group's sealer without sender authentication
  // Uses ephemeral key pair, embeds ephemeral public key in output
  abstract sealForGroup<T extends JsonValue>(args: {
    message: T;
    to: SealerID;
    nOnceMaterial: { in: RawCoID; tx: TransactionID };
  }): SealedForGroup<T>;

  // Decrypt data sealed to a group
  // Extracts ephemeral public key from sealed data, derives shared secret
  abstract unsealForGroup<T extends JsonValue>(
    sealed: SealedForGroup<T>,
    groupSealerSecret: SealerSecret,
    nOnceMaterial: { in: RawCoID; tx: TransactionID },
  ): T | undefined;

  uniquenessForHeader(): `z${string}` {
    return `z${base58.encode(this.randomBytes(12))}`;
  }

  createdNowUnique(): {
    createdAt: `2${string}`;
    uniqueness: `z${string}`;
  } {
    const createdAt = new Date().toISOString() as `2${string}`;
    return {
      createdAt,
      uniqueness: this.uniquenessForHeader(),
    };
  }

  newRandomSecretSeed(): Uint8Array {
    return this.randomBytes(secretSeedLength);
  }

  agentSecretFromSecretSeed(secretSeed: Uint8Array): AgentSecret {
    if (secretSeed.length !== secretSeedLength) {
      throw new Error(`Secret seed needs to be ${secretSeedLength} bytes long`);
    }

    return `sealerSecret_z${base58.encode(
      this.blake3HashOnceWithContext(secretSeed, {
        context: textEncoder.encode("seal"),
      }),
    )}/signerSecret_z${base58.encode(
      this.blake3HashOnceWithContext(secretSeed, {
        context: textEncoder.encode("sign"),
      }),
    )}`;
  }

  newRandomSessionID(accountID: RawAccountID | AgentID): ActiveSessionID {
    const randomPart = base58.encode(this.randomBytes(8));
    return `${accountID}_session_z${randomPart}`;
  }

  newDeleteSessionID(accountID: RawAccountID | AgentID): DeleteSessionID {
    const randomPart = base58.encode(this.randomBytes(7));
    return `${accountID}_session_d${randomPart}$`;
  }

  abstract createSessionMap(
    coID: RawCoID,
    headerJson: string,
    maxTxSize?: number,
    skipVerify?: boolean,
  ): SessionMapImpl;

  /**
   * Node-level registry backed by a native `NodeCore`. Every provider
   * (Napi/Wasm/RN) overrides this with its native registry adapter — there is
   * no TS shim fallback.
   */
  abstract createNodeCore(): NodeCoreImpl;
}

export type Hash = `hash_z${string}`;
export type ShortHash = `shortHash_z${string}`;
export const shortHashLength = 19;

export type Encrypted<
  T extends JsonValue,
  N extends JsonValue,
> = `encrypted_U${string}` & { __type: T; __nOnceMaterial: N };

export type KeySecret = `keySecret_z${string}`;
export type KeyID = `key_z${string}`;

export const secretSeedLength = 32;

/**
 * SessionMapImpl - Native implementation of SessionMap
 * One instance per CoValue, owns all session data including header
 */
export interface SessionMapImpl {
  // === Header ===
  getHeader(): string;

  // === Transaction Operations ===
  addTransactions(
    sessionId: string,
    signerId: string | undefined,
    transactionsJson: string,
    signature: string,
    skipVerify: boolean,
  ): void;

  makeNewPrivateTransaction(
    sessionId: string,
    signerSecret: string,
    changesJson: string,
    keyId: string,
    keySecret: string,
    metaJson: string | undefined,
    madeAt: number,
  ): string; // Returns JSON: { signature, transaction }

  makeNewTrustingTransaction(
    sessionId: string,
    signerSecret: string,
    changesJson: string,
    metaJson: string | undefined,
    madeAt: number,
  ): string; // Returns JSON: { signature, transaction }

  // === Session Queries ===
  getSessionIds(): string[];
  getTransactionCount(sessionId: string): number; // -1 if not found
  getTransaction(sessionId: string, txIndex: number): Transaction | undefined;
  getSessionTransactions(
    sessionId: string,
    fromIndex: number,
  ): Transaction[] | undefined;
  getLastSignature(sessionId: string): string | undefined;
  getSignatureAfter(sessionId: string, txIndex: number): string | undefined;
  getLastSignatureCheckpoint(sessionId: string): number | undefined; // -1 if no checkpoints, undefined if session not found

  // === Known State ===
  getKnownState(): {
    id: string;
    header: boolean;
    sessions: Record<string, number>;
  };
  getKnownStateWithStreaming():
    | { id: string; header: boolean; sessions: Record<string, number> }
    | undefined;
  isStreaming(): boolean;
  setStreamingKnownState(streamingJson: string): void;

  // === Deletion ===
  markAsDeleted(): void;
  isDeleted(): boolean;

  // === Decryption ===
  decryptTransaction(
    sessionId: string,
    txIndex: number,
    keySecret: string,
  ): string | undefined;
  decryptTransactionMeta(
    sessionId: string,
    txIndex: number,
    keySecret: string,
  ): string | undefined;

  /** Optional: free native resources eagerly (wasm). */
  dispose?(): void;
}

export type NodeCorePendingTx = {
  sessionId: string;
  txIndex: number;
  sourceMadeAt?: number;
  /** Decrypted meta JSON for this pending tx; takes precedence over the
   * TRUSTING tx's own wire `meta` field. See `PendingTxIn::meta_json`
   * (cojson-core). */
  metaJson?: string;
  /**
   * Merged-transaction source identity. NOTE the `sessionID` casing here
   * matches {@link TransactionID} (this codebase's convention for
   * transaction-identity wire objects), NOT the napi-generated `SourceTxId`
   * object, whose fields are plain camelCase (`sessionId`/`txIndex`) because
   * napi objects bypass serde's `#[serde(rename)]`. The NapiCrypto adapter is
   * the seam that converts `{sessionID, txIndex}` -> `{sessionId, txIndex}`
   * when calling into the native binding.
   */
  sourceTxId?: { sessionID: string; txIndex: number };
};
export type NodeCoreGroupVerdict = {
  sessionId: string;
  txIndex: number;
  valid: boolean;
  outcome: "valid" | "invalid" | "validBranchPointerOnly";
  reason?: string;
};
/**
 * A DELTA of validation verdicts returned by
 * {@link NodeCoreImpl.validateTransactionsDelta}: only the verdicts the caller
 * has not yet seen, tagged with the engine `generation` and the `fromIndex` at
 * which they begin in the full verdict list.
 *
 *  - `fromIndex === 0`  → the WHOLE list is returned (a full recompute may have
 *    reordered/flipped verdicts, or the caller had no cursor). The caller resets
 *    its cursor and re-applies everything.
 *  - `fromIndex === sinceCount` → only the appended tail is returned; the prefix
 *    the caller already applied is unchanged (engine generation contract).
 */
export type NodeCoreVerdictDelta = {
  generation: number;
  fromIndex: number;
  verdicts: NodeCoreGroupVerdict[];
};

/**
 * The compact result of {@link NodeCoreImpl.ingestAndMaterialize} (R3 stage-2b):
 * the ONLY payload that crosses the boundary per content chunk for a native-path
 * coMap. Validation happens in-crate, so no per-transaction verdict array is
 * marshalled.
 *
 *  - `generation`/`count` advance the caller's `validationCursor` (same cursor
 *    the {@link NodeCoreVerdictDelta} protocol uses).
 *  - `viewVersion` is the coMap view's monotonic version after materialization —
 *    the delta cursor a `RawCoMap` passes as `sinceVersion` on its NEXT pull.
 *  - `deltaJson` is the RICH delta `{version, reset, changedKeys}` (each
 *    `changedKeys[k]` a full ordered `MapOp[]`), the payload a `RawCoMap`
 *    rebuilds its `ops`/`latest` from.
 */
export type NodeCoreIngestOutcome = {
  generation: number;
  count: number;
  viewVersion: number;
  deltaJson: string;
};

/**
 * NodeCoreImpl - node-level registry of per-CoValue session state.
 * One instance per LocalNode; every method addresses a CoValue by its id.
 */
export interface NodeCoreImpl {
  // === Registry ===
  createCoValue(
    coId: string,
    headerJson: string,
    maxTxSize?: number,
    skipVerify?: boolean,
  ): void;
  hasCoValue(coId: string): boolean;
  /** No-op if absent. Frees the CoValue's native memory. */
  removeCoValue(coId: string): void;
  coValueCount(): number;

  // === Header ===
  getHeader(coId: string): string;

  // === Transaction Operations ===
  addTransactions(
    coId: string,
    sessionId: string,
    signerId: string | undefined,
    transactionsJson: string,
    signature: string,
    skipVerify: boolean,
  ): void;
  makeNewPrivateTransaction(
    coId: string,
    sessionId: string,
    signerSecret: string,
    changesJson: string,
    keyId: string,
    keySecret: string,
    metaJson: string | undefined,
    madeAt: number,
  ): string;
  makeNewTrustingTransaction(
    coId: string,
    sessionId: string,
    signerSecret: string,
    changesJson: string,
    metaJson: string | undefined,
    madeAt: number,
  ): string;

  // === Session Queries ===
  getSessionIds(coId: string): string[];
  getTransactionCount(coId: string, sessionId: string): number;
  getTransaction(
    coId: string,
    sessionId: string,
    txIndex: number,
  ): Transaction | undefined;
  getSessionTransactions(
    coId: string,
    sessionId: string,
    fromIndex: number,
  ): Transaction[] | undefined;
  getLastSignature(coId: string, sessionId: string): string | undefined;
  getSignatureAfter(
    coId: string,
    sessionId: string,
    txIndex: number,
  ): string | undefined;
  getLastSignatureCheckpoint(
    coId: string,
    sessionId: string,
  ): number | undefined;

  // === Known State ===
  getKnownState(coId: string): {
    id: string;
    header: boolean;
    sessions: Record<string, number>;
  };
  getKnownStateWithStreaming(
    coId: string,
  ):
    | { id: string; header: boolean; sessions: Record<string, number> }
    | undefined;
  isStreaming(coId: string): boolean;
  setStreamingKnownState(coId: string, streamingJson: string): void;

  // === Deletion ===
  markAsDeleted(coId: string): void;
  isDeleted(coId: string): boolean;

  // === Decryption ===
  decryptTransaction(
    coId: string,
    sessionId: string,
    txIndex: number,
    keySecret: string,
  ): string | undefined;
  decryptTransactionMeta(
    coId: string,
    sessionId: string,
    txIndex: number,
    keySecret: string,
  ): string | undefined;

  /**
   * Unified native transaction validation (stage 3, subsuming stage 2's
   * `validateGroup`). Validates EVERY ruleset (group, ownedByGroup,
   * unsafeAllowAll).
   * Throws "Unknown CoValue: <id>" for an unregistered `coId` and
   * "CoValue not loaded: <id>" when a dependency (parent group / owning
   * account) is missing from the registry.
   */
  validateTransactions(
    coId: string,
    pending: NodeCorePendingTx[],
  ): NodeCoreGroupVerdict[];
  /**
   * DELTA-returning transaction validation. Given the caller's
   * `(sinceGeneration, sinceCount)` cursor, returns only the verdicts it has not
   * seen (see {@link NodeCoreVerdictDelta}). On a generation match the untouched
   * prefix is NOT re-sent, so per-ingest marshalling stays O(new). `pending` need
   * only carry the extras for the NEW transactions this pass — the engine keeps
   * earlier merge/branch extras resident. Same error contract as
   * {@link NodeCoreImpl.validateTransactions}.
   */
  validateTransactionsDelta(
    coId: string,
    sinceGeneration: number,
    sinceCount: number,
    pending: NodeCorePendingTx[],
  ): NodeCoreVerdictDelta;
  /**
   * Native role resolution (stage 2).
   * Error contract identical to {@link NodeCoreImpl.validateTransactions}.
   */
  roleOf(groupId: string, member: string, atTime?: number): string | undefined;
  /**
   * Drop the cached validation engine for `coId`, forcing a full recompute on
   * the next `validateTransactions`/`roleOf`.
   *
   * LOAD-BEARING CALLER CONTRACT (mirrors `NodeCore::reset_validation` on the
   * Rust side): the engine cache is keyed ONLY by per-session transaction
   * counts — `pending` (decrypted meta / source identities) is NOT part of
   * the key. If pending changes without a new transaction (e.g. a private
   * tx's meta decrypts later), verdicts stay stale until this is called.
   * Callers MUST invoke this everywhere TS calls
   * `CoValueCore.resetParsedTransactions`, and nowhere else. An absent `coId`
   * is a no-op, not an error.
   */
  resetValidation(coId: string): void;

  /**
   * R1 (experimental): feed a resolved `KeyID -> KeySecret` to the native key
   * store so Rust can decrypt that key's PRIVATE transactions during coMap
   * materialization. TS keeps ownership of key MANAGEMENT (unsealing, rotation,
   * revelation chains) and calls this once it has resolved a read key. Idempotent
   * — re-providing the same secret is a no-op. The secret enters native memory
   * and is never handed back across the boundary (see `NodeCore::provide_key_secret`).
   */
  provideKeySecret(keyId: string, keySecret: string): void;

  /**
   * R3 stage-2b: native coMap materialization surface. The native side keeps a
   * Rust-resident materialized view of every gated coMap (plain `comap` with a
   * non-`group` ruleset); TS consumes it through the delta/frontier reads below
   * instead of walking `getValidTransactions` in TS.
   *
   * Materialize (or incrementally refresh) `coId`'s coMap view against the
   * currently-known valid transactions; returns the view's monotonic version.
   * `pending` carries the same per-tx extras as {@link validateTransactions}
   * (empty for the plain non-branched fast path).
   */
  mapMaterialize(coId: string, pending: NodeCorePendingTx[]): number;
  /** Latest JSON-encoded value for `key` (undefined = absent). */
  mapGet(coId: string, key: string): string | undefined;
  /** JSON-encoded value for `key` at `atTime` (ms; omit for latest). */
  mapGetAt(coId: string, key: string, atTime?: number): string | undefined;
  /** Whole materialized map as a JSON object string. */
  mapSnapshot(coId: string): string;
  /** `{version, changedKeys, deletedKeys}` since `sinceVersion`, as JSON. */
  mapDelta(coId: string, sinceVersion: number): string;
  /**
   * RICH delta `{version, reset, changedKeys}` since `sinceVersion`, as JSON —
   * each `changedKeys[k]` the full ordered `MapOp[]` op-list for a changed key.
   * `reset` tells the caller to clear and rebuild its `ops`/`latest` from the
   * full delta; otherwise it patches the changed keys. See
   * {@link NodeCoreIngestOutcome}.
   */
  mapDeltaRich(coId: string, sinceVersion: number): string;
  /**
   * Frontier read: latest frontier-visible value of `key` (undefined = absent).
   * `frontierJson` is `{ sessionID: txCount }`.
   */
  mapGetAtFrontier(
    coId: string,
    key: string,
    frontierJson: string,
  ): string | undefined;
  /** Frontier read: whole `{key: latestVisibleValue}` snapshot as JSON. */
  mapSnapshotAtFrontier(coId: string, frontierJson: string): string;
  /**
   * R3 stage-2b single-call ingest: add a content chunk's transactions to the
   * raw session log, validate them in-crate, and materialize the coMap view in
   * ONE FFI crossing — returning the compact {@link NodeCoreIngestOutcome}. The
   * raw session log is still written, so TS sync/storage (which read raw
   * sessions) are unaffected. Error contract matches {@link addTransactions}
   * (bad signature / deleted covalue / malformed tx JSON surface unchanged and
   * leave no view mutation).
   */
  ingestAndMaterialize(
    coId: string,
    sessionId: string,
    signerId: string | undefined,
    transactionsJson: string,
    signature: string,
    skipVerify: boolean,
    sinceVersion: number,
    pending: NodeCorePendingTx[],
  ): NodeCoreIngestOutcome;
  /**
   * The `KeyID`s `coId`'s materialized view still needs a secret for (a private
   * tx used a key not yet in the native key store). The caller resolves each in
   * TS ({@link AvailableCoValueCore.getReadKey}), feeds it via
   * {@link provideKeySecret}, and re-materializes.
   */
  missingKeyIds(coId: string): string[];

  /**
   * Whether this adapter's native binding actually exposes the stage-2b coMap
   * materialization surface ({@link ingestAndMaterialize} & friends). The napi
   * and wasm bindings always do; the React Native uniffi binding only does after
   * an `ubrn` regeneration (like `validateTransactionsDelta`, the RN glue is a
   * build product). When this is `false` the coMap receive path stays on the TS
   * `getValidTransactions` materializer, so RN keeps working unchanged until its
   * bindings are regenerated.
   */
  supportsNativeCoMapMaterialization(): boolean;
}
