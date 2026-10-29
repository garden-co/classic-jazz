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
  // We track the knownTransactions in multiple CoValues because branches
  // need to retrieve the transactions from both the source and the branch
  knownTransactions: Record<RawCoID, number> = {};
  totalValidTransactions: number = 0;
  version: number = 0;

  /**
   * True when this coMap's `ops`/`latest` are fed by the native (Rust-resident)
   * materializer via {@link consumeNativeDelta} instead of the TS
   * {@link processNewTransactions} walk over `getValidTransactions`. Set once at
   * construction from {@link CoValueCore.isNativeCoMap} — plain `comap`s with a
   * non-`group` ruleset that are NOT branched, on a binding that exposes the
   * stage-2b surface. Groups and accounts (which extend this class) keep the TS
   * path because their ruleset IS `group`; branched coMaps keep it because their
   * merge folds a source's `getValidTransactions`.
   */
  readonly nativeMaterialization: boolean;

  /**
   * Refcount of `sessionID:txIndex` -> number of ops currently in `ops` that
   * come from that transaction. Drives {@link totalValidTransactions} (its
   * `size` = distinct contributing valid transactions) under the native path,
   * where the rich delta replaces a key's whole op-list at once. Unused on the
   * TS path.
   */
  #nativeTxRefcount = new Map<string, number>();
  /** Whether the native view has been materialized into this content at least
   * once — the first materialization does NOT bump {@link version} (it is the
   * initial build, like the TS constructor's first `processNewTransactions`);
   * later full rebuilds (`reset` deltas) do. */
  #nativeMaterializedOnce = false;

  protected resetInternalState() {
    this.ops = {};
    this.latest = {};
    this.knownTransactions = { [this.core.id]: 0 };
    this.totalValidTransactions = 0;
    this.#nativeTxRefcount.clear();
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

    // The native path can't honor `ignorePrivateTransactions` (the Rust view
    // always materializes decrypted private txs), but plain coMaps are never
    // constructed with it — only groups/accounts (TS path) are. Guard anyway.
    this.nativeMaterialization =
      !this.ignorePrivateTransactions && this.core.isNativeCoMap();

    if (this.nativeMaterialization) {
      this.core.materializeNativeCoMapContent(this);
    } else {
      this.processNewTransactions();
    }
  }

  /**
   * Rebuild `ops`/`latest` from a native RICH delta (`{version, reset,
   * changedKeys}`, each `changedKeys[k]` a full `MapOp[]` already in
   * `compareTransactions` order). On `reset` the store is cleared and rebuilt;
   * otherwise each changed key's op-list is replaced wholesale (the only way the
   * native path removes ops from a key is a `reset`). The resulting `MapOp`
   * shape is byte-identical to the TS path's, so every reader
   * (`getRaw`/`editsAt`/`atTime`/`atFrontier`/…) is unchanged.
   */
  consumeNativeDelta(delta: {
    version: number;
    reset: boolean;
    changedKeys: Record<string, MapOp<keyof Shape & string, JsonValue>[]>;
  }) {
    if (delta.reset) {
      // A full recompute after the initial build is a rebuild (fww flip, verdict
      // flip, or a private key arriving) — bump `version` exactly as the TS path
      // does in `rebuildFromCore`.
      if (this.#nativeMaterializedOnce) {
        this.version += 1;
      }
      this.ops = {};
      this.latest = {};
      this.#nativeTxRefcount.clear();
    }

    const ops = this.ops as Record<
      string,
      MapOp<keyof Shape & string, JsonValue>[]
    >;
    const latest = this.latest as Record<
      string,
      MapOp<keyof Shape & string, JsonValue> | undefined
    >;

    for (const key in delta.changedKeys) {
      const opList = delta.changedKeys[key]!;
      const previous = ops[key];
      if (previous) {
        for (const op of previous) this.#decNativeTxRef(op.txID);
      }
      ops[key] = opList;
      for (const op of opList) this.#incNativeTxRef(op.txID);
      latest[key] = opList.length > 0 ? opList[opList.length - 1] : undefined;
    }

    this.totalValidTransactions = this.#nativeTxRefcount.size;
    this.#nativeMaterializedOnce = true;
  }

  #incNativeTxRef(txID: TransactionID) {
    const k = `${txID.sessionID}:${txID.txIndex}`;
    this.#nativeTxRefcount.set(k, (this.#nativeTxRefcount.get(k) ?? 0) + 1);
  }

  #decNativeTxRef(txID: TransactionID) {
    const k = `${txID.sessionID}:${txID.txIndex}`;
    const n = (this.#nativeTxRefcount.get(k) ?? 0) - 1;
    if (n <= 0) this.#nativeTxRefcount.delete(k);
    else this.#nativeTxRefcount.set(k, n);
  }

  processNewTransactions() {
    // Under the native path the core drives materialization through
    // `consumeNativeDelta`; the TS walk is a no-op here (callers like `set`/
    // `assign`/`delete` still invoke it after `makeTransaction`, but the core's
    // own `processNewTransactions` already pushed the native delta).
    if (this.nativeMaterialization) {
      return;
    }

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
      keyof typeof ops,
      NonNullable<(typeof ops)[keyof typeof ops]>
    >();

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
          entries.push(entry);
          changedEntries.set(change.key, entries);
        }
      }

      this.handleNewTransaction(transaction);
    }

    for (const entries of changedEntries.values()) {
      entries.sort(this.core.compareTransactions);
    }

    for (const [key, entries] of changedEntries.entries()) {
      this.latest[key] = entries[entries.length - 1];
    }

    this.totalValidTransactions += newValidTransactions.length;
  }

  handleNewTransaction(transaction: DecryptedTransaction) {}

  rebuildFromCore() {
    if (this.nativeMaterialization) {
      // Full re-pull from the native view. `version` is bumped by
      // `consumeNativeDelta` on the `reset` this triggers (so we don't double
      // it here).
      this.resetInternalState();
      this.#nativeMaterializedOnce = false;
      this.version += 1;
      this.core.materializeNativeCoMapContent(this);
      return;
    }

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
    return (Object.keys(this.ops) as K[]).filter((key) => {
      const entry = this.getRaw(key);

      if (entry === undefined) {
        return false;
      }

      if (entry.change.op === "del") {
        return false;
      }

      return true;
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

    for (const key of Object.keys(this.ops) as (keyof Shape & string)[]) {
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
