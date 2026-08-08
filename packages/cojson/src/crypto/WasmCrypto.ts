import {
  SessionMap as WasmSessionMap,
  initialize,
  initializeSync,
  Blake3Hasher,
  blake3HashOnce,
  blake3HashOnceWithContext,
  decrypt,
  encrypt,
  getSealerId,
  getSignerId,
  newEd25519SigningKey,
  newX25519PrivateKey,
  seal,
  sealForGroup,
  shortHash,
  sign,
  unseal,
  unsealForGroup,
  verify,
} from "cojson-core-wasm";
import { base64URLtoBytes, bytesToBase64url } from "../base64url.js";
import { RawCoID, TransactionID } from "../ids.js";
import { Transaction } from "../coValueCore/verifiedState.js";
import { Stringified, stableStringify } from "../jsonStringify.js";
import { JsonValue } from "../jsonValue.js";
import { logger } from "../logger.js";
import {
  CryptoProvider,
  Encrypted,
  KeySecret,
  Sealed,
  SealedForGroup,
  SealerID,
  SealerSecret,
  SessionMapImpl,
  ShortHash,
  Signature,
  SignerID,
  SignerSecret,
  textDecoder,
  textEncoder,
} from "./crypto.js";
import { isCloudflare, isEvalAllowed } from "../platformUtils.js";

type Blake3State = Blake3Hasher;

let wasmInit = initialize;
let wasmInitSync = initializeSync;

const wasmCryptoErrorMessage = (
  e: unknown,
) => `Critical Error: Failed to load WASM module

${!isEvalAllowed() ? `You need to add \`import "jazz-tools/load-edge-wasm";\` on top of your entry module to make Jazz work with ${isCloudflare() ? "Cloudflare workers" : "this runtime"}` : (e as Error).message}

A native crypto module is required for Jazz to work. See https://jazz.tools/docs/react/reference/performance#use-the-best-crypto-implementation-for-your-platform for possible alternatives.`;

/**
 * Initializes the WasmCrypto module. This function can be used to initialize the WasmCrypto module in a worker or a browser.
 * if you are using SSR and you want to initialize WASM crypto asynchronously you can use this function.
 * @returns A promise that resolves when the WasmCrypto module is successfully initialized.
 */
export async function initWasmCrypto() {
  try {
    await wasmInit();
  } catch (e) {
    throw new Error(wasmCryptoErrorMessage(e), { cause: e });
  }
}

/**
 * WebAssembly implementation of the CryptoProvider interface using cojson-core-wasm.
 * This provides the primary implementation using WebAssembly for optimal performance, offering:
 * - Signing/verifying (Ed25519)
 * - Encryption/decryption (XSalsa20)
 * - Sealing/unsealing (X25519 + XSalsa20-Poly1305)
 * - Hashing (BLAKE3)
 */
export class WasmCrypto extends CryptoProvider<Blake3State> {
  protected constructor() {
    super();
  }

  static setInit(value: typeof initialize) {
    wasmInit = value;
  }

  static setInitSync(value: typeof initializeSync) {
    wasmInitSync = value;
  }

  static createSync(): WasmCrypto {
    try {
      wasmInitSync();
    } catch (e) {
      throw new Error(wasmCryptoErrorMessage(e), { cause: e });
    }
    return new WasmCrypto();
  }

  // TODO: Remove this method and use createSync instead, this is not necessary since we can use createSync in the browser and in the worker.
  // @deprecated
  static async create(): Promise<WasmCrypto> {
    await initWasmCrypto();
    return new WasmCrypto();
  }

  blake3HashOnce(data: Uint8Array) {
    return blake3HashOnce(data);
  }

  blake3HashOnceWithContext(
    data: Uint8Array,
    { context }: { context: Uint8Array },
  ) {
    return blake3HashOnceWithContext(data, context);
  }

  shortHash(value: JsonValue): ShortHash {
    return shortHash(stableStringify(value)) as ShortHash;
  }

  newEd25519SigningKey(): Uint8Array {
    return newEd25519SigningKey();
  }

  getSignerID(secret: SignerSecret): SignerID {
    return getSignerId(textEncoder.encode(secret)) as SignerID;
  }

  sign(secret: SignerSecret, message: JsonValue): Signature {
    return sign(
      textEncoder.encode(stableStringify(message)),
      textEncoder.encode(secret),
    ) as Signature;
  }

  verify(signature: Signature, message: JsonValue, id: SignerID): boolean {
    const result = verify(
      textEncoder.encode(signature),
      textEncoder.encode(stableStringify(message)),
      textEncoder.encode(id),
    );

    return result;
  }

  newX25519StaticSecret(): Uint8Array {
    return newX25519PrivateKey();
  }

  getSealerID(secret: SealerSecret): SealerID {
    return getSealerId(textEncoder.encode(secret)) as SealerID;
  }

  encrypt<T extends JsonValue, N extends JsonValue>(
    value: T,
    keySecret: KeySecret,
    nOnceMaterial: N,
  ): Encrypted<T, N> {
    return `encrypted_U${bytesToBase64url(
      encrypt(
        textEncoder.encode(stableStringify(value)),
        keySecret,
        textEncoder.encode(stableStringify(nOnceMaterial)),
      ),
    )}` as Encrypted<T, N>;
  }

  decryptRaw<T extends JsonValue, N extends JsonValue>(
    encrypted: Encrypted<T, N>,
    keySecret: KeySecret,
    nOnceMaterial: N,
  ): Stringified<T> {
    return textDecoder.decode(
      decrypt(
        base64URLtoBytes(encrypted.substring("encrypted_U".length)),
        keySecret,
        textEncoder.encode(stableStringify(nOnceMaterial)),
      ),
    ) as Stringified<T>;
  }

  seal<T extends JsonValue>({
    message,
    from,
    to,
    nOnceMaterial,
  }: {
    message: T;
    from: SealerSecret;
    to: SealerID;
    nOnceMaterial: { in: RawCoID; tx: TransactionID };
  }): Sealed<T> {
    return `sealed_U${bytesToBase64url(
      seal(
        textEncoder.encode(stableStringify(message)),
        from,
        to,
        textEncoder.encode(stableStringify(nOnceMaterial)),
      ),
    )}` as Sealed<T>;
  }

  unseal<T extends JsonValue>(
    sealed: Sealed<T>,
    sealer: SealerSecret,
    from: SealerID,
    nOnceMaterial: { in: RawCoID; tx: TransactionID },
  ): T | undefined {
    const plaintext = textDecoder.decode(
      unseal(
        base64URLtoBytes(sealed.substring("sealed_U".length)),
        sealer,
        from,
        textEncoder.encode(stableStringify(nOnceMaterial)),
      ),
    );
    try {
      return JSON.parse(plaintext) as T;
    } catch (e) {
      logger.error("Failed to decrypt/parse sealed message", { err: e });
      return undefined;
    }
  }

  sealForGroup<T extends JsonValue>({
    message,
    to,
    nOnceMaterial,
  }: {
    message: T;
    to: SealerID;
    nOnceMaterial: { in: RawCoID; tx: TransactionID };
  }): SealedForGroup<T> {
    return `sealedForGroup_U${bytesToBase64url(
      sealForGroup(
        textEncoder.encode(stableStringify(message)),
        to,
        textEncoder.encode(stableStringify(nOnceMaterial)),
      ),
    )}` as SealedForGroup<T>;
  }

  unsealForGroup<T extends JsonValue>(
    sealed: SealedForGroup<T>,
    groupSealerSecret: SealerSecret,
    nOnceMaterial: { in: RawCoID; tx: TransactionID },
  ): T | undefined {
    try {
      const plaintext = textDecoder.decode(
        unsealForGroup(
          base64URLtoBytes(sealed.substring("sealedForGroup_U".length)),
          groupSealerSecret,
          textEncoder.encode(stableStringify(nOnceMaterial)),
        ),
      );
      return JSON.parse(plaintext) as T;
    } catch (e) {
      logger.error("Failed to decrypt/parse sealed for group message", {
        err: e,
      });
      return undefined;
    }
  }

  createSessionMap(
    coID: RawCoID,
    headerJson: string,
    maxTxSize?: number,
    skipVerify?: boolean,
  ): SessionMapImpl {
    return new SessionMapAdapter(
      new WasmSessionMap(coID, headerJson, maxTxSize, skipVerify),
    );
  }
}

/**
 * Adapter wrapping WasmSessionMap to implement SessionMapImpl interface
 */
class SessionMapAdapter implements SessionMapImpl {
  constructor(private readonly sessionMap: WasmSessionMap) {}

  // Batch decrypt fast path. Deleted from the prototype below when the
  // underlying (prebuilt) wasm binary doesn't expose `decryptTransactions`,
  // so callers transparently fall back to the per-transaction path.
  decryptTransactions?(
    sessionID: string,
    indices: Uint32Array,
    keySecret: string,
  ): string | undefined {
    return (
      (this.sessionMap as any).decryptTransactions(
        sessionID,
        indices,
        keySecret,
      ) ?? undefined
    );
  }

  // === Header ===
  getHeader(): string {
    return this.sessionMap.getHeader();
  }

  // === Transaction Operations ===
  addTransactions(
    sessionId: string,
    signerId: string | undefined,
    transactionsJson: string,
    signature: string,
    skipVerify: boolean,
  ): void {
    this.sessionMap.addTransactions(
      sessionId,
      signerId,
      transactionsJson,
      signature,
      skipVerify,
    );
  }

  makeNewPrivateTransaction(
    sessionId: string,
    signerSecret: string,
    changesJson: string,
    keyId: string,
    keySecret: string,
    metaJson: string | undefined,
    madeAt: number,
  ): string {
    return this.sessionMap.makeNewPrivateTransaction(
      sessionId,
      signerSecret,
      changesJson,
      keyId,
      keySecret,
      metaJson,
      madeAt,
    );
  }

  makeNewTrustingTransaction(
    sessionId: string,
    signerSecret: string,
    changesJson: string,
    metaJson: string | undefined,
    madeAt: number,
  ): string {
    return this.sessionMap.makeNewTrustingTransaction(
      sessionId,
      signerSecret,
      changesJson,
      metaJson,
      madeAt,
    );
  }

  // === Session Queries ===
  getSessionIds(): string[] {
    return this.sessionMap.getSessionIds();
  }

  getTransactionCount(sessionId: string): number {
    return this.sessionMap.getTransactionCount(sessionId);
  }

  getTransaction(sessionId: string, txIndex: number): Transaction | undefined {
    const result = this.sessionMap.getTransaction(sessionId, txIndex);
    if (!result) return undefined;
    return JSON.parse(result) as Transaction;
  }

  getSessionTransactions(
    sessionId: string,
    fromIndex: number,
  ): Transaction[] | undefined {
    const result = this.sessionMap.getSessionTransactions(sessionId, fromIndex);
    if (!result) return undefined;
    return result.map((tx) => JSON.parse(tx) as Transaction);
  }

  getLastSignature(sessionId: string): string | undefined {
    return this.sessionMap.getLastSignature(sessionId) ?? undefined;
  }

  getSignatureAfter(sessionId: string, txIndex: number): string | undefined {
    return this.sessionMap.getSignatureAfter(sessionId, txIndex) ?? undefined;
  }

  getLastSignatureCheckpoint(sessionId: string): number | undefined {
    return this.sessionMap.getLastSignatureCheckpoint(sessionId) ?? undefined;
  }

  // === Known State ===
  getKnownState(): {
    id: string;
    header: boolean;
    sessions: Record<string, number>;
  } {
    // WASM returns a native JS object via serde_wasm_bindgen
    return this.sessionMap.getKnownState() as {
      id: string;
      header: boolean;
      sessions: Record<string, number>;
    };
  }

  getKnownStateWithStreaming():
    | { id: string; header: boolean; sessions: Record<string, number> }
    | undefined {
    // WASM returns a native JS object via serde_wasm_bindgen, or undefined
    const result = this.sessionMap.getKnownStateWithStreaming();
    if (!result || result === undefined) return undefined;
    return result as {
      id: string;
      header: boolean;
      sessions: Record<string, number>;
    };
  }

  isStreaming(): boolean {
    return this.sessionMap.isStreaming();
  }

  setStreamingKnownState(streamingJson: string): void {
    this.sessionMap.setStreamingKnownState(streamingJson);
  }

  // === Deletion ===
  markAsDeleted(): void {
    this.sessionMap.markAsDeleted();
  }

  isDeleted(): boolean {
    return this.sessionMap.isDeleted();
  }

  // === Decryption ===
  decryptTransaction(
    sessionId: string,
    txIndex: number,
    keySecret: string,
  ): string | undefined {
    return (
      this.sessionMap.decryptTransaction(sessionId, txIndex, keySecret) ??
      undefined
    );
  }

  decryptTransactionMeta(
    sessionId: string,
    txIndex: number,
    keySecret: string,
  ): string | undefined {
    return (
      this.sessionMap.decryptTransactionMeta(sessionId, txIndex, keySecret) ??
      undefined
    );
  }
}

// Whether the loaded (possibly prebuilt, possibly outdated) wasm binary
// exposes the batch decrypt fast path is a static property of the binary:
// detect it once, instead of feature-probing per adapter instance.
if (
  typeof (WasmSessionMap.prototype as any).decryptTransactions !== "function"
) {
  delete SessionMapAdapter.prototype.decryptTransactions;
}
