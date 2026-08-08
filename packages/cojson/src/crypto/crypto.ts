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

  /**
   * Batch fast path for decrypting several private transactions in a single
   * native call. Optional: older/other native implementations (napi, RN, or an
   * outdated prebuilt wasm binary) won't expose it, and callers must fall back
   * to per-transaction `decryptTransaction`.
   *
   * Returns a JSON array string where element i corresponds to indices[i]:
   * either the decrypted changes (a JSON array value) or `null` if that
   * transaction couldn't be decrypted. Returns `undefined` if the session
   * doesn't exist. The combined string may fail to JSON.parse if a decrypted
   * plaintext was corrupt, so callers must catch and fall back.
   */
  decryptTransactions?(
    sessionID: string,
    indices: Uint32Array,
    keySecret: string,
  ): string | undefined;
}
