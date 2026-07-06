import { base64URLtoBytes, bytesToBase64url } from "../base64url.js";
import type { CoID, RawCoValue } from "../coValue.js";
import type { AvailableCoValueCore } from "../coValueCore/coValueCore.js";
import type { RawCoID } from "../ids.js";
import type { JsonObject } from "../jsonValue.js";
import type { RawGroup } from "./group.js";
import { CoValueFrontier } from "../knownState.js";

export type BinaryStreamInfo = {
  mimeType: string;
  fileName?: string;
  totalSizeBytes?: number;
};

export type BinaryStreamStart = {
  type: "start";
} & BinaryStreamInfo;

export type BinaryStreamChunk = {
  type: "chunk";
  chunk: `binary_U${string}`;
};

export type BinaryStreamEnd = {
  type: "end";
};

export type BinaryCoStreamMeta = JsonObject & { type: "binary" };

export type BinaryStreamItem =
  | BinaryStreamStart
  | BinaryStreamChunk
  | BinaryStreamEnd;

const binary_U_prefixLength = 8; // "binary_U".length;

export class RawBinaryCoStreamView<
  Meta extends BinaryCoStreamMeta = { type: "binary" },
> implements RawCoValue
{
  id: CoID<this>;
  type = "costream" as const;
  core: AvailableCoValueCore;
  knownTransactions: Record<RawCoID, number>;
  totalValidTransactions: number = 0;
  version: number = 0;
  private chunks: string[];
  /**
   * Incrementally decoded prefix of `chunks`, maintained only while the
   * stream is unfinished so that download-progress polling
   * (`getBinaryChunks(allowUnfinished)` per update) decodes each chunk once
   * instead of re-decoding the whole file on every read. Dropped as soon as
   * the stream ends: finished files are decoded fresh per read (typically
   * exactly once, e.g. `toBlob`), so nothing is retained long-term. The
   * buffers are shared across polling reads and must be treated as immutable.
   */
  private decodedChunks: Uint8Array<ArrayBuffer>[];
  private start: BinaryStreamStart | undefined;
  private ended: boolean;

  /** @internal */
  atFrontierFilter?: CoValueFrontier = undefined;

  private resetInternalState() {
    this.chunks = [];
    this.decodedChunks = [];
    this.start = undefined;
    this.ended = false;
    this.knownTransactions = { [this.core.id]: 0 };
    this.totalValidTransactions = 0;
  }

  constructor(
    core: AvailableCoValueCore,
    options?: {
      atFrontierFilter?: CoValueFrontier;
    },
  ) {
    this.id = core.id as CoID<this>;
    this.core = core;
    this.ended = false;
    this.chunks = [];
    this.decodedChunks = [];
    this.knownTransactions = { [core.id]: 0 };
    this.atFrontierFilter = options?.atFrontierFilter;
    this.processNewTransactions();
  }

  rebuildFromCore() {
    this.version++;

    this.resetInternalState();
    this.processNewTransactions();
  }

  get headerMeta(): Meta {
    return this.core.verified.header.meta as Meta;
  }

  get group(): RawGroup {
    return this.core.getGroup();
  }

  /** Not yet implemented */
  atTime(_time: number): this {
    throw new Error("Not yet implemented");
  }

  atFrontier(frontier: CoValueFrontier): this {
    return new RawBinaryCoStreamView(this.core, {
      atFrontierFilter: frontier,
    }) as this;
  }

  isTimeTravelEntity(): boolean {
    return Boolean(this.atFrontierFilter);
  }

  processNewTransactions() {
    if (this.ended) return;

    const newValidTransactions = this.core.getValidTransactions({
      ignorePrivateTransactions: false,
      knownTransactions: this.knownTransactions,
    });

    if (newValidTransactions.length === 0) {
      return;
    }

    for (const { txID, changes } of newValidTransactions) {
      if (
        this.atFrontierFilter &&
        txID.txIndex >= (this.atFrontierFilter[txID.sessionID] ?? -1)
      ) {
        continue;
      }

      for (const changeUntyped of changes) {
        const change = changeUntyped as BinaryStreamItem;

        if (change.type === "chunk") {
          this.chunks.push(change.chunk.slice(binary_U_prefixLength));
        } else if (change.type === "start") {
          this.start = change;
        } else if (change.type === "end") {
          this.ended = true;
        }
      }
    }

    if (this.ended) {
      // The progress-polling decode cache is only worth its memory while the
      // stream is still growing
      this.decodedChunks = [];
    }

    this.totalValidTransactions += newValidTransactions.length;
  }

  isBinaryStreamEnded() {
    return this.ended;
  }

  getBinaryStreamInfo(): BinaryStreamInfo | undefined {
    if (!this.start) return;

    const start = this.start;

    return {
      mimeType: start.mimeType,
      fileName: start.fileName,
      totalSizeBytes: start.totalSizeBytes,
    };
  }

  getBinaryChunks(allowUnfinished?: boolean):
    | (BinaryStreamInfo & {
        chunks: Uint8Array<ArrayBuffer>[];
        finished: boolean;
      })
    | undefined {
    if (!this.start) return;
    if (!this.ended && !allowUnfinished) return;

    const start = this.start;

    let chunks: Uint8Array<ArrayBuffer>[];
    if (this.ended) {
      // Finished files are read rarely (typically once): decode fresh and
      // retain nothing
      chunks = this.chunks.map(base64URLtoBytes);
    } else {
      // Unfinished files are polled repeatedly while chunks stream in:
      // decode only the chunks added since the previous read
      const decoded = this.decodedChunks;
      for (let i = decoded.length; i < this.chunks.length; i++) {
        decoded.push(base64URLtoBytes(this.chunks[i]!));
      }
      chunks = decoded.slice();
    }

    return {
      mimeType: start.mimeType,
      fileName: start.fileName,
      totalSizeBytes: start.totalSizeBytes,
      chunks,
      finished: this.ended,
    };
  }

  toJSON() {
    return {};
  }

  subscribe(listener: (coStream: this) => void): () => void {
    return this.core.subscribe((core) => {
      listener(core.getCurrentContent() as this);
    });
  }
}

export class RawBinaryCoStream<
    Meta extends BinaryCoStreamMeta = { type: "binary" },
  >
  extends RawBinaryCoStreamView<Meta>
  implements RawCoValue
{
  override atFrontier(frontier: CoValueFrontier): this {
    return new RawBinaryCoStream(this.core, {
      atFrontierFilter: frontier,
    }) as this;
  }

  /** @internal */
  push(
    item: BinaryStreamItem,
    privacy: "private" | "trusting" = "private",
    updateView: boolean = true,
  ): void {
    if (this.isTimeTravelEntity()) {
      throw new Error("Cannot mutate a time travel entity");
    }

    this.core.makeTransaction([item], privacy);
    if (updateView) {
      this.processNewTransactions();
    }
  }

  startBinaryStream(
    settings: BinaryStreamInfo,
    privacy: "private" | "trusting" = "private",
  ): void {
    this.push(
      {
        type: "start",
        ...settings,
      } satisfies BinaryStreamStart,
      privacy,
      false,
    );
  }

  pushBinaryStreamChunk(
    chunk: Uint8Array,
    privacy: "private" | "trusting" = "private",
  ): void {
    this.push(
      {
        type: "chunk",
        chunk: `binary_U${bytesToBase64url(chunk)}`,
      } satisfies BinaryStreamChunk,
      privacy,
      false,
    );
  }

  endBinaryStream(privacy: "private" | "trusting" = "private") {
    this.push(
      {
        type: "end",
      } satisfies BinaryStreamEnd,
      privacy,
      true,
    );
  }
}
