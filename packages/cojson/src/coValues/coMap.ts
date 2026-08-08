import { CoID, RawCoValue } from "../coValue.js";
import {
  AvailableCoValueCore,
  DecryptedTransaction,
} from "../coValueCore/coValueCore.js";
import { AgentID, RawCoID, TransactionID } from "../ids.js";
import { JsonObject, JsonValue } from "../jsonValue.js";
import { accountOrAgentIDfromSessionID } from "../typeUtils/accountOrAgentIDfromSessionID.js";
import { isCoValue } from "../typeUtils/isCoValue.js";
import { RawAccountID } from "./account.js";
import type { RawGroup } from "./group.js";
import { CoValueFrontier } from "../knownState.js";

type MapOp<K extends string, V extends JsonValue | undefined> = {
  txID: TransactionID;
  madeAt: number;
  changeIdx: number;
  change: MapOpPayload<K, V>;
  trusting?: boolean;
};
// TODO: add after TransactionID[] for conflicts/ordering

export type MapOpPayload<K extends string, V extends JsonValue | undefined> =
  | {
      op: "set";
      key: K;
      value: V;
    }
  | {
      op: "del";
      key: K;
    };

export class RawCoMap<
  Shape extends { [key: string]: JsonValue | undefined } = {
    [key: string]: JsonValue | undefined;
  },
  Meta extends JsonObject | null = JsonObject | null,
> implements RawCoValue
{
  /** @category 6. Meta */
  id: CoID<this>;
  /** @category 6. Meta */
  type = "comap" as const;
  /** @category 6. Meta */
  core: AvailableCoValueCore;

  /** @internal */
  get latestTxMadeAt(): number {
    return this.core.latestTxMadeAt;
  }

  /** @internal */
  get earliestTxMadeAt(): number {
    return this.core.earliestTxMadeAt;
  }

  /** The internal state of the RawCoMap */
  ops: {
    [Key in keyof Shape & string]?: MapOp<Key, Shape[Key]>[];
  } = {};
  latest: {
    [Key in keyof Shape & string]?: MapOp<Key, Shape[Key]>;
  } = {};
  /**
   * Cached result of `keys()` (present keys in `Object.keys(this.ops)` order),
   * maintained incrementally across batches; `null` means "rebuild lazily on
   * the next keys() call". Not used by time-travel clones, which filter ops
   * per read. A plain (TS-private) property so `Object.create`-based clones
   * stay valid.
   */
  private cachedKeys: (keyof Shape & string)[] | null = null;
  // We track the knownTransactions in multiple CoValues because branches
  // need to retrieve the transactions from both the source and the branch
  knownTransactions: Record<RawCoID, number> = {};
  totalValidTransactions: number = 0;
  version: number = 0;

  protected resetInternalState() {
    this.ops = {};
    this.latest = {};
    this.cachedKeys = null;
    this.knownTransactions = { [this.core.id]: 0 };
    this.totalValidTransactions = 0;
  }

  /** @internal */
  ignorePrivateTransactions: boolean;
  /** @internal */
  atTimeFilter?: number = undefined;
  /** @internal */
  atFrontierFilter?: CoValueFrontier = undefined;
  /** @category 6. Meta */
  readonly _shape!: Shape;

  /** @internal */
  constructor(
    core: AvailableCoValueCore,
    options?: {
      ignorePrivateTransactions: boolean;
    },
  ) {
    this.id = core.id as CoID<this>;
    this.core = core;

    this.ignorePrivateTransactions =
      options?.ignorePrivateTransactions ?? false;

    this.processNewTransactions();
  }

  processNewTransactions() {
    if (this.isTimeTravelEntity()) {
      throw new Error("Cannot process transactions on a time travel entity");
    }

    const newValidTransactions = this.core.getValidTransactions({
      ignorePrivateTransactions: this.ignorePrivateTransactions,
      knownTransactions: this.knownTransactions,
    });

    if (newValidTransactions.length === 0) {
      return;
    }

    const { ops } = this;

    const changedEntries = new Map<
      keyof Shape & string,
      MapOp<keyof Shape & string, Shape[keyof Shape & string]>[]
    >();
    // Keys whose appended ops arrived out of time order (rare): only these
    // need a re-sort; in-order appends keep the sorted invariant by
    // themselves.
    const unsortedKeys = new Set<keyof Shape & string>();

    for (const transaction of newValidTransactions) {
      const { txID, changes, madeAt, tx } = transaction;

      for (let changeIdx = 0; changeIdx < changes.length; changeIdx++) {
        const change = changes[changeIdx] as MapOpPayload<
          keyof Shape & string,
          Shape[keyof Shape & string]
        >;
        const entry = {
          txID,
          madeAt,
          changeIdx,
          change,
          trusting: tx.privacy === "trusting",
        };

        const entries = ops[change.key];
        if (!entries) {
          const entries = [entry];
          ops[change.key] = entries;
          changedEntries.set(change.key, entries);
        } else {
          if (
            this.core.compareTransactions(entries[entries.length - 1]!, entry) >
            0
          ) {
            unsortedKeys.add(change.key);
          }
          entries.push(entry);
          changedEntries.set(change.key, entries);
        }
      }

      this.handleNewTransaction(transaction);
    }

    // The cache is only created in keys(), never during this loop, so a null
    // check here covers the whole batch.
    const cacheLive = this.cachedKeys !== null;

    for (const [key, entries] of changedEntries) {
      if (unsortedKeys.has(key)) {
        entries.sort(this.core.compareTransactions);
      }

      const latest = entries[entries.length - 1]!;
      if (cacheLive) {
        this.updateCachedKeys(key, this.latest[key], latest);
      }
      this.latest[key] = latest;
    }

    this.totalValidTransactions += newValidTransactions.length;
  }

  /**
   * Maintains `cachedKeys` for one key touched by a batch. Only presence
   * transitions matter: a brand-new visible key appends (matching
   * `Object.keys` order for non-integer keys), anything that changes an
   * existing key's presence — or a new integer-like key, which JS would
   * order numerically before string keys — drops the cache so the next
   * `keys()` call rebuilds it.
   *
   * `previous === undefined` means the key is new: on a live instance every
   * key in `ops` gets `latest` assigned by the batch that first created it.
   */
  private updateCachedKeys(
    key: keyof Shape & string,
    previous: MapOp<keyof Shape & string, JsonValue | undefined> | undefined,
    latest: MapOp<keyof Shape & string, JsonValue | undefined>,
  ) {
    const cached = this.cachedKeys;
    if (cached === null) {
      return;
    }

    if (previous === undefined) {
      if (!isPresentOp(latest)) {
        // Deleted before ever being visible: keys() filters it out
        return;
      }
      // charCode short-circuit: real-world keys almost never start with a
      // digit, so skip the regex for them
      const firstChar = key.charCodeAt(0);
      if (firstChar >= 48 && firstChar <= 57 && INTEGER_LIKE_KEY.test(key)) {
        this.cachedKeys = null;
        return;
      }
      cached.push(key);
      return;
    }

    if (isPresentOp(previous) !== isPresentOp(latest)) {
      // The key's position in Object.keys order is its original first-op
      // position, so a reappearing/disappearing key needs a rebuild.
      this.cachedKeys = null;
    }
  }

  handleNewTransaction(transaction: DecryptedTransaction) {}

  rebuildFromCore() {
    this.version += 1;

    this.resetInternalState();
    this.processNewTransactions();
  }

  isTimeTravelEntity() {
    return Boolean(this.atTimeFilter) || Boolean(this.atFrontierFilter);
  }

  /** @category 6. Meta */
  get headerMeta(): Meta {
    return this.core.verified.header.meta as Meta;
  }

  /** @category 6. Meta */
  get group(): RawGroup {
    return this.core.getGroup();
  }

  /** @category 4. Time travel */
  atTime(time: number): this {
    const clone = Object.create(this) as RawCoMap<Shape, Meta>;

    clone.atTimeFilter = time;
    clone.latest = {};

    return clone as this;
  }

  /** @category 4. Time travel */
  atFrontier(frontier: CoValueFrontier): this {
    const clone = Object.create(this) as RawCoMap<Shape, Meta>;
    clone.atFrontierFilter = frontier;
    clone.latest = {};
    return clone as this;
  }

  /**
   * Get all keys currently in the map.
   *
   * @category 1. Reading */
  keys<K extends keyof Shape & string = keyof Shape & string>(): K[] {
    // Time-travel clones filter per read and share `ops` with the live
    // instance, so they never use the cache.
    if (this.isTimeTravelEntity()) {
      return this.computeKeys();
    }

    let cached = this.cachedKeys;
    if (cached === null) {
      cached = this.computeKeys();
      this.cachedKeys = cached;
    }
    return cached.slice() as K[];
  }

  private computeKeys<
    K extends keyof Shape & string = keyof Shape & string,
  >(): K[] {
    return (Object.keys(this.ops) as K[]).filter((key) => {
      const entry = this.getRaw(key);
      return entry !== undefined && isPresentOp(entry);
    });
  }

  getRaw<K extends keyof Shape & string>(key: K) {
    let latestChange = this.latest[key];

    if (latestChange === undefined) {
      const entries = this.ops[key];

      // Time travel values are lazily computed
      if (entries && !(key in this.latest)) {
        latestChange = entries.findLast(
          (op) =>
            (this.atTimeFilter === undefined ||
              op.madeAt <= this.atTimeFilter) &&
            (this.atFrontierFilter === undefined ||
              op.txID.txIndex <
                (this.atFrontierFilter[op.txID.sessionID] ?? -1)),
        );

        this.latest[key] = latestChange;
      }

      if (latestChange === undefined) {
        return undefined;
      }
    }

    return latestChange;
  }

  /**
   * Returns the current value for the given key.
   *
   * @category 1. Reading
   **/
  get<K extends keyof Shape & string>(key: K): Shape[K] | undefined {
    const entry = this.getRaw(key);

    if (entry?.change === undefined) {
      return undefined;
    }

    if (entry.change.op === "del") {
      return undefined;
    } else {
      return entry.change.value as Shape[K];
    }
  }

  /** @category 1. Reading */
  asObject(): {
    [K in keyof Shape & string]: Shape[K];
  } {
    const object: Partial<{
      [K in keyof Shape & string]: Shape[K];
    }> = {};

    for (const key of this.keys()) {
      const value = this.get(key);
      if (value !== undefined) {
        object[key] = value;
      }
    }

    return object as {
      [K in keyof Shape & string]: Shape[K];
    };
  }

  /** @category 1. Reading */
  toJSON(): {
    [K in keyof Shape & string]: Shape[K];
  } {
    return this.asObject();
  }

  /** @category 5. Edit history */
  nthEditAt<K extends keyof Shape & string>(key: K, n: number) {
    const ops = this.ops[key];

    const entry = ops?.[n];

    if (!entry) {
      return undefined;
    }

    if (this.atTimeFilter && entry.madeAt > this.atTimeFilter) {
      return undefined;
    }

    if (
      this.atFrontierFilter &&
      entry.txID.txIndex >= (this.atFrontierFilter[entry.txID.sessionID] ?? -1)
    ) {
      return undefined;
    }

    return operationToEditEntry(entry);
  }

  /** @category 5. Edit history */
  lastEditAt<K extends keyof Shape & string>(
    key: K,
  ):
    | {
        by: RawAccountID | AgentID;
        tx: TransactionID;
        at: Date;
        value?: Shape[K];
      }
    | undefined {
    const entry = this.getRaw(key);

    if (!entry) {
      return undefined;
    }

    return operationToEditEntry(entry);
  }

  /** @category 5. Edit history */
  *editsAt<K extends keyof Shape & string>(key: K) {
    const entries = this.ops[key];

    if (!entries) {
      return;
    }

    for (const entry of entries) {
      // Entries are sorted by madeAt
      if (this.atTimeFilter && entry.madeAt > this.atTimeFilter) {
        return;
      }

      if (
        this.atFrontierFilter &&
        entry.txID.txIndex >=
          (this.atFrontierFilter[entry.txID.sessionID] ?? -1)
      ) {
        return;
      }

      yield operationToEditEntry(entry);
    }
  }

  /** @category 3. Subscription */
  subscribe(listener: (coMap: this) => void): () => void {
    return this.core.subscribe((core) => {
      listener(core.getCurrentContent() as this);
    });
  }

  /** Set a new value for the given key.
   *
   * If `privacy` is `"private"` **(default)**, both `key` and `value` are encrypted in the transaction, only readable by other members of the group this `CoMap` belongs to. Not even sync servers can see the content in plaintext.
   *
   * If `privacy` is `"trusting"`, both `key` and `value` are stored in plaintext in the transaction, visible to everyone who gets a hold of it, including sync servers.
   *
   * @category 2. Editing
   **/
  set<K extends keyof Shape & string>(
    key: K,
    value: Shape[K],
    privacy: "private" | "trusting" = "private",
  ): void {
    if (this.isTimeTravelEntity()) {
      throw new Error("Cannot set value on a time travel entity");
    }

    this.core.makeTransaction(
      [
        {
          op: "set",
          key,
          value: isCoValue(value) ? value.id : value,
        },
      ],
      privacy,
    );

    this.processNewTransactions();
  }

  assign(
    entries: Partial<Shape>,
    privacy: "private" | "trusting" = "private",
    meta?: JsonObject,
  ): void {
    if (this.isTimeTravelEntity()) {
      throw new Error("Cannot set value on a time travel entity");
    }

    this.core.makeTransaction(
      Object.entries(entries).map(([key, value]) => ({
        op: "set",
        key,
        value: isCoValue(value) ? value.id : value,
      })),
      privacy,
      meta,
    );

    this.processNewTransactions();
  }

  /** Delete the given key (setting it to undefined).
   *
   * If `privacy` is `"private"` **(default)**, `key` is encrypted in the transaction, only readable by other members of the group this `CoMap` belongs to. Not even sync servers can see the content in plaintext.
   *
   * If `privacy` is `"trusting"`, `key` is stored in plaintext in the transaction, visible to everyone who gets a hold of it, including sync servers.
   *
   * @category 2. Editing
   **/
  delete(
    key: keyof Shape & string,
    privacy: "private" | "trusting" = "private",
  ) {
    if (this.isTimeTravelEntity()) {
      throw new Error("Cannot delete value on a time travel entity");
    }

    this.core.makeTransaction(
      [
        {
          op: "del",
          key,
        },
      ],
      privacy,
    );

    this.processNewTransactions();
  }
}

// Keys that JavaScript treats as array indices and orders numerically before
// string keys in Object.keys (conservatively: any all-digit key).
const INTEGER_LIKE_KEY = /^\d+$/;

/** The single definition of "this op makes its key visible in keys()". */
function isPresentOp(op: MapOp<string, JsonValue | undefined>): boolean {
  return op.change.op !== "del";
}

export function operationToEditEntry<
  K extends string,
  V extends JsonValue | undefined,
>(op: MapOp<K, V>) {
  return {
    by: accountOrAgentIDfromSessionID(op.txID.sessionID),
    tx: op.txID,
    at: new Date(op.madeAt),
    value: op.change.op === "del" ? undefined : op.change.value,
  };
}
