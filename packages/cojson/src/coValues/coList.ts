import { CoID, RawCoValue } from "../coValue.js";
import {
  AvailableCoValueCore,
  DecryptedTransaction,
} from "../coValueCore/coValueCore.js";
import { AgentID, TransactionID, RawCoID } from "../ids.js";
import { JsonObject, JsonValue } from "../jsonValue.js";
import { accountOrAgentIDfromSessionID } from "../typeUtils/accountOrAgentIDfromSessionID.js";
import { isCoValue } from "../typeUtils/isCoValue.js";
import { RawAccountID } from "./account.js";
import { RawGroup } from "./group.js";
import { CoValueFrontier } from "../knownState.js";

export type OpID = TransactionID & { changeIdx: number };

export type InsertionOpPayload<T extends JsonValue> =
  | {
      op: "pre";
      value: T;
      before: OpID | "end";
    }
  | {
      op: "app";
      value: T;
      after: OpID | "start";
    };

export type DeletionOpPayload = {
  op: "del";
  insertion: OpID;
};

export type ListOpPayload<T extends JsonValue> =
  | InsertionOpPayload<T>
  | DeletionOpPayload;

type InsertionEntry<T extends JsonValue> = {
  madeAt: number;
  /** The OpID of this insertion, stored once so it can be reused in results */
  opID: OpID;
  /** Entries inserted directly before this one ("pre" ops targeting it) */
  predecessors: InsertionEntry<T>[];
  /**
   * Entries inserted directly after this one ("app" ops targeting it).
   * Successors render newest-first (see `fillArrayFromEntry`), which is why
   * `appendItems` writes multi-item appends in reverse order.
   */
  successors: InsertionEntry<T>[];
  change: InsertionOpPayload<T>;
  /** Whether this entry comes from a valid transaction */
  isValid: boolean;
  /** Number of deletion ops targeting this insertion (>0 means deleted) */
  deletionsCount: number;
  /** Traversal generation marker, used instead of a visited Set */
  visitedGen: number;
};

type DeletionEntry = {
  madeAt: number;
  deletionID: OpID;
  change: DeletionOpPayload;
};

/**
 * Summary of one `processNewTransactions` batch, used afterwards by
 * `computeCacheTailSuffix` to decide whether `_cachedEntries` can be
 * extended in place instead of being invalidated.
 *
 * Only created when there is a live cache to maintain (see
 * `beginBatchSummary`). The `prior*` snapshots are taken before the batch
 * touches the graph, so the entries the batch attached at the tail region
 * can be identified by iterating past them.
 */
class BatchSummary<Item extends JsonValue> {
  /**
   * Set when the batch contains an op that in-place cache extension doesn't
   * support: deletions and prepends (which can affect entries before the
   * tail) and duplicate ops (double merges).
   */
  hasUnsupportedOps = false;
  /**
   * Number of valid "app" insertions added by this batch. The cache can only
   * be kept if all of them render after the previous tail.
   */
  newValidAppends = 0;

  constructor(
    /** The insertion entry of the last cached (visible) item, if any. */
    readonly tail: InsertionEntry<Item> | undefined,
    /** `tail.successors.length` before the batch. */
    readonly priorTailSuccessors: number,
    /** `afterStart.length` before the batch. */
    readonly priorAfterStartRoots: number,
  ) {}

  record(change: ListOpPayload<Item>, isValid: boolean, applied: boolean) {
    if (!applied || change.op === "del" || change.op === "pre") {
      this.hasUnsupportedOps = true;
    } else if (isValid) {
      this.newValidAppends++;
    }
  }
}

export class RawCoList<
  Item extends JsonValue = JsonValue,
  Meta extends JsonObject | null = null,
> implements RawCoValue
{
  /** @category 6. Meta */
  id: CoID<this>;
  /** @category 6. Meta */
  type: "colist" | "coplaintext" = "colist" as const;
  /** @category 6. Meta */
  core: AvailableCoValueCore;

  /** The internal state of the RawCoList */
  afterStart: InsertionEntry<Item>[] = [];
  beforeEnd: InsertionEntry<Item>[] = [];
  /** All insertion entries, keyed by their encoded OpID */
  insertions: Map<OpIDKey, InsertionEntry<Item>> = new Map();
  /** Traversal generation counter, bumped on every traversal (full or suffix) */
  private traversalGen = 0;
  /** Deletion ops targeting an insertion, keyed by the insertion's encoded OpID */
  deletionsByInsertion: Map<OpIDKey, DeletionEntry[]> = new Map();

  /** @internal */
  atTimeFilter?: number = undefined;

  /** @internal */
  atFrontierFilter?: CoValueFrontier = undefined;

  /** @category 6. Meta */
  readonly _item!: Item;

  /** @internal */
  _cachedEntries?: {
    value: Item;
    madeAt: number;
    opID: OpID;
  }[];
  knownTransactions: Record<RawCoID, number> = {};
  version: number = 0;
  lastValidTransaction: number | undefined;
  totalValidTransactions: number = 0;

  #isDeletionRestricted: boolean;

  private resetInternalState() {
    this.afterStart = [];
    this.beforeEnd = [];
    this.insertions = new Map();
    this.deletionsByInsertion = new Map();
    this._cachedEntries = undefined;
    this.knownTransactions = { [this.core.id]: 0 };
    this.lastValidTransaction = undefined;
    this.totalValidTransactions = 0;
  }

  /** @internal */
  constructor(
    core: AvailableCoValueCore,
    options?: {
      atTimeFilter?: number;
      atFrontierFilter?: CoValueFrontier;
    },
  ) {
    this.id = core.id as CoID<this>;
    this.core = core;

    this.insertions = new Map();
    this.deletionsByInsertion = new Map();
    this.afterStart = [];
    this.beforeEnd = [];
    this.knownTransactions = { [core.id]: 0 };
    this.atTimeFilter = options?.atTimeFilter;
    this.atFrontierFilter = options?.atFrontierFilter;

    const ruleset = this.core.verified.header.ruleset;
    this.#isDeletionRestricted =
      ruleset.type === "ownedByGroup" && ruleset.restrictDeletion === true;

    this.processNewTransactions();
  }

  private getInsertionsEntry(opID: OpID) {
    return this.insertions.get(encodeOpID(opID));
  }

  private createInsertionsEntry(opID: OpID, value: InsertionEntry<Item>) {
    const key = encodeOpID(opID);

    // The key may already exist in case of double merges
    if (this.insertions.has(key)) {
      return false;
    }

    // Deletions targeting this insertion may have been processed first
    value.deletionsCount = this.deletionsByInsertion.get(key)?.length ?? 0;

    this.insertions.set(key, value);
    return true;
  }

  private pushDeletionsByInsertionEntry(opID: OpID, value: DeletionEntry) {
    const key = encodeOpID(opID);

    let list = this.deletionsByInsertion.get(key);
    if (!list) {
      list = [];
      this.deletionsByInsertion.set(key, list);
    }

    list.push(value);

    // Keep the deletion count on the insertion entry in sync, if it exists
    const insertionEntry = this.insertions.get(key);
    if (insertionEntry) {
      insertionEntry.deletionsCount++;
    }
  }

  processNewTransactions() {
    // Get all transactions including invalid ones, so that items referencing
    // entries from invalid init transactions can still find their references.
    const transactions = this.core.getValidSortedTransactions({
      ignorePrivateTransactions: false,
      knownTransactions: this.knownTransactions,
      includeInvalidMetaTransactions: true,
    });

    if (transactions.length === 0) {
      return;
    }

    const batch = this.beginBatchSummary();

    let lastValidTransaction: number | undefined = undefined;
    let oldestValidTransaction: number | undefined = undefined;

    for (const tx of transactions) {
      if (this.isFilteredOut(tx) || this.isDeletionDenied(tx)) {
        continue;
      }

      const { changes, madeAt, isValid } = tx;

      // Only track valid transactions for the lastValidTransaction/oldestValidTransaction
      if (isValid) {
        lastValidTransaction = Math.max(lastValidTransaction ?? 0, madeAt);
        oldestValidTransaction = Math.min(
          oldestValidTransaction ?? Infinity,
          madeAt,
        );
      }

      for (let changeIdx = 0; changeIdx < changes.length; changeIdx++) {
        const change = changes[changeIdx] as ListOpPayload<Item>;
        const applied = this.ingestChange(change, tx, changeIdx);
        batch?.record(change, isValid, applied);
      }
    }

    if (
      this.lastValidTransaction &&
      oldestValidTransaction &&
      oldestValidTransaction < this.lastValidTransaction
    ) {
      // The batch contains transactions older than already-processed ones:
      // rebuild so everything is applied in order (this also re-attaches ops
      // that arrived before their target and were dropped as orphans).
      this.rebuildFromCore();
    } else {
      this.lastValidTransaction = lastValidTransaction;

      const suffix = batch ? this.computeCacheTailSuffix(batch) : null;
      if (suffix) {
        for (const entry of suffix) {
          this._cachedEntries!.push(entry);
        }
      } else {
        this._cachedEntries = undefined;
      }
    }

    this.totalValidTransactions += transactions.length;
  }

  /**
   * In groups with restricted deletion, deletion transactions from members
   * that are not admins or managers are dropped entirely.
   */
  private isDeletionDenied(tx: DecryptedTransaction): boolean {
    if (!tx.isValid || !this.#isDeletionRestricted) {
      return false;
    }

    const changes = tx.changes as ListOpPayload<Item>[];
    if (!changes.some((change) => change.op === "del")) {
      return false;
    }

    const author = accountOrAgentIDfromSessionID(tx.txID.sessionID);
    const role = this.group.atTime(tx.madeAt).roleOfInternal(author);

    return role !== "admin" && role !== "manager";
  }

  /**
   * Applies a single op to the insertion graph. Returns false when the op
   * was already present (double merges) and nothing was applied.
   */
  private ingestChange(
    change: ListOpPayload<Item>,
    tx: DecryptedTransaction,
    changeIdx: number,
  ): boolean {
    const opID: OpID = {
      sessionID: tx.txID.sessionID,
      txIndex: tx.txID.txIndex,
      branch: tx.txID.branch,
      changeIdx,
    };

    if (change.op === "del") {
      this.pushDeletionsByInsertionEntry(change.insertion, {
        madeAt: tx.madeAt,
        deletionID: opID,
        change,
      });
      return true;
    }

    if (change.op !== "pre" && change.op !== "app") {
      throw new Error(
        "Unknown list operation " + (change as { op: unknown }).op,
      );
    }

    const entry: InsertionEntry<Item> = {
      madeAt: tx.madeAt,
      opID,
      predecessors: [],
      successors: [],
      change,
      isValid: tx.isValid,
      deletionsCount: 0,
      visitedGen: 0,
    };

    if (!this.createInsertionsEntry(opID, entry)) {
      return false;
    }

    if (change.op === "pre") {
      if (change.before === "end") {
        this.beforeEnd.push(entry);
      } else {
        this.getInsertionsEntry(change.before)?.predecessors.push(entry);
      }
    } else if (change.after === "start") {
      this.afterStart.push(entry);
    } else {
      // When `after` is unknown the op stays orphaned and invisible until a
      // rebuild re-processes it after its target arrives
      this.getInsertionsEntry(change.after)?.successors.push(entry);
    }

    return true;
  }

  /**
   * A batch summary is only worth keeping when there is a cache to maintain:
   * without one (or on a time-travel view, whose cache is conservatively
   * invalidated on any new transactions) the batch always ends in
   * invalidation.
   */
  private beginBatchSummary(): BatchSummary<Item> | undefined {
    if (this._cachedEntries === undefined || this.isTimeTravelEntity()) {
      return undefined;
    }

    const lastCached = this._cachedEntries[this._cachedEntries.length - 1];
    const tail = lastCached
      ? this.getInsertionsEntry(lastCached.opID)
      : undefined;

    return new BatchSummary(
      tail,
      tail?.successors.length ?? 0,
      this.afterStart.length,
    );
  }

  /**
   * Called after a batch has been ingested into the graph: returns the
   * entries to append to `_cachedEntries` when the batch is a pure tail
   * extension (the common case: appends arriving in order, e.g. while
   * streaming or on local appendItems), or null when it isn't and the cache
   * must be invalidated.
   *
   * A batch is a pure tail extension when every entry it made visible
   * renders after the previously last visible entry. Instead of proving
   * this op by op, we collect the subtrees the batch attached at the tail
   * region (new successors of the old tail, then new afterStart roots), run
   * the regular traversal over just those subtrees, and check that it
   * emitted exactly the batch's valid appends: an op that attached anywhere
   * else leaves the traversal short. Reusing `fillArrayFromEntry` for the
   * suffix keeps the incremental order in agreement with a full rebuild by
   * construction.
   */
  private computeCacheTailSuffix(
    batch: BatchSummary<Item>,
  ): { value: Item; madeAt: number; opID: OpID }[] | null {
    if (batch.hasUnsupportedOps) {
      return null;
    }

    // New roots render after all old afterStart subtrees but before any
    // beforeEnd subtree, so they only extend the tail if beforeEnd is empty.
    const hasNewAfterStartRoots =
      this.afterStart.length > batch.priorAfterStartRoots;
    if (hasNewAfterStartRoots && this.beforeEnd.length > 0) {
      return null;
    }

    // The subtrees the batch attached at the tail region, in the order the
    // full traversal reaches them: successors of the old tail newest-first,
    // then the new afterStart roots.
    const suffixRoots: InsertionEntry<Item>[] = [];
    if (batch.tail) {
      const successors = batch.tail.successors;
      for (let i = successors.length - 1; i >= batch.priorTailSuccessors; i--) {
        suffixRoots.push(successors[i]!);
      }
    }
    for (let i = batch.priorAfterStartRoots; i < this.afterStart.length; i++) {
      suffixRoots.push(this.afterStart[i]!);
    }

    const suffix: { value: Item; madeAt: number; opID: OpID }[] = [];
    const gen = ++this.traversalGen;
    for (const root of suffixRoots) {
      this.fillArrayFromEntry(root, suffix, gen);
    }

    // Every valid append of the batch must have landed in the suffix:
    // anything else (an append to a mid-list entry, an orphaned append, an
    // insertion that a previous batch already deleted) means the cached
    // prefix can no longer be trusted.
    if (suffix.length !== batch.newValidAppends) {
      return null;
    }

    return suffix;
  }

  rebuildFromCore() {
    this.version += 1;

    this.resetInternalState();
    this.processNewTransactions();
  }

  isTimeTravelEntity() {
    return Boolean(this.atTimeFilter) || Boolean(this.atFrontierFilter);
  }

  private isFilteredOut(tx: DecryptedTransaction): boolean {
    if (this.atTimeFilter !== undefined && tx.madeAt > this.atTimeFilter) {
      return true;
    }

    if (
      this.atFrontierFilter !== undefined &&
      tx.txID.txIndex >= (this.atFrontierFilter[tx.txID.sessionID] ?? -1)
    ) {
      return true;
    }

    return false;
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
    return new RawCoList(this.core, {
      atTimeFilter: time,
    }) as this;
  }

  /** @category 4. Time travel */
  atFrontier(frontier: CoValueFrontier): this {
    return new RawCoList(this.core, {
      atFrontierFilter: frontier,
    }) as this;
  }

  /**
   * Get the item currently at `idx`.
   *
   * @category 1. Reading
   */
  get(idx: number): Item | undefined {
    const entry = this.entries()[idx];
    if (!entry) {
      return undefined;
    }
    return entry.value;
  }

  /**
   * Returns the current items in the CoList as an array.
   *
   * @category 1. Reading
   **/
  asArray(): Item[] {
    return this.entries().map((entry) => entry.value);
  }

  /** @internal */
  entries(): {
    value: Item;
    madeAt: number;
    opID: OpID;
  }[] {
    if (this._cachedEntries) {
      return this._cachedEntries;
    }
    const arr = this.entriesUncached();
    this._cachedEntries = arr;
    return arr;
  }

  length() {
    return this.entries().length;
  }

  /** @internal */
  entriesUncached(): {
    value: Item;
    madeAt: number;
    opID: OpID;
  }[] {
    const arr: {
      value: Item;
      madeAt: number;
      opID: OpID;
    }[] = [];
    const gen = ++this.traversalGen;
    for (const entry of this.afterStart) {
      this.fillArrayFromEntry(entry, arr, gen);
    }
    for (const entry of this.beforeEnd) {
      this.fillArrayFromEntry(entry, arr, gen);
    }
    return arr;
  }

  /** @internal */
  private fillArrayFromEntry(
    root: InsertionEntry<Item>,
    arr: {
      value: Item;
      madeAt: number;
      opID: OpID;
    }[],
    gen: number,
  ) {
    const todo = [root]; // a stack with the next item to do at the end

    while (todo.length > 0) {
      const entry = todo[todo.length - 1]!;

      // We navigate the predecessors before processing the current entry in the list
      if (entry.predecessors.length > 0 && entry.visitedGen !== gen) {
        entry.visitedGen = gen;
        for (const predecessor of entry.predecessors) {
          todo.push(predecessor);
        }
      } else {
        // Remove the current entry from the todo stack to consider it processed.
        todo.pop();

        // Skip entries that are deleted or from invalid transactions
        // (e.g., losing init transactions in firstComesWins scenarios)
        if (entry.deletionsCount === 0 && entry.isValid) {
          arr.push({
            value: entry.change.value,
            madeAt: entry.madeAt,
            opID: entry.opID,
          });
        }

        // traverse successors in reverse for correct insertion behavior
        for (const successor of entry.successors) {
          todo.push(successor);
        }
      }
    }
  }

  /**
   * Returns the current items in the CoList as an array. (alias of `asArray`)
   *
   * @category 1. Reading
   */
  toJSON(): Item[] {
    return this.asArray();
  }

  /** @category 5. Edit history */
  editAt(idx: number):
    | {
        by: RawAccountID | AgentID;
        tx: TransactionID;
        at: Date;
        value: Item;
      }
    | undefined {
    const entry = this.entries()[idx];
    if (!entry) {
      return undefined;
    }
    const madeAt = new Date(entry.madeAt);
    const by = accountOrAgentIDfromSessionID(entry.opID.sessionID);
    const value = entry.value;
    return {
      by,
      tx: {
        sessionID: entry.opID.sessionID,
        txIndex: entry.opID.txIndex,
      },
      at: madeAt,
      value,
    };
  }

  /** @category 5. Edit history */
  deletionEdits(): {
    by: RawAccountID | AgentID;
    tx: TransactionID;
    at: Date;
    // TODO: add indices that are now before and after the deleted item
  }[] {
    const edits: {
      by: RawAccountID | AgentID;
      tx: TransactionID;
      at: Date;
    }[] = [];

    for (const deletions of this.deletionsByInsertion.values()) {
      for (const deletion of deletions) {
        edits.push({
          by: accountOrAgentIDfromSessionID(deletion.deletionID.sessionID),
          tx: deletion.deletionID,
          at: new Date(deletion.madeAt),
        });
      }
    }

    return edits;
  }

  /** @category 3. Subscription */
  subscribe(listener: (coList: this) => void): () => void {
    return this.core.subscribe((core) => {
      listener(core.getCurrentContent() as this);
    });
  }

  /** Appends `item` after the item currently at index `after`.
   *
   * If `privacy` is `"private"` **(default)**, `item` is encrypted in the transaction, only readable by other members of the group this `CoList` belongs to. Not even sync servers can see the content in plaintext.
   *
   * If `privacy` is `"trusting"`, `item` is stored in plaintext in the transaction, visible to everyone who gets a hold of it, including sync servers.
   *
   * @category 2. Editing
   **/
  append(
    item: Item,
    after?: number,
    privacy: "private" | "trusting" = "private",
  ) {
    this.appendItems([item], after, privacy);
  }

  /**
   * Appends `items` to the list at index `after`. If `after` is negative, it is treated as `0`.
   *
   * If `privacy` is `"private"` **(default)**, `items` are encrypted in the transaction, only readable by other members of the group this `CoList` belongs to. Not even sync servers can see the content in plaintext.
   *
   * If `privacy` is `"trusting"`, `items` are stored in plaintext in the transaction, visible to everyone who gets a hold of it, including sync servers.
   *
   * @category 2. Editing
   */
  appendItems(
    items: Item[],
    after?: number,
    privacy: "private" | "trusting" = "private",
    meta?: JsonObject,
  ) {
    if (this.isTimeTravelEntity()) {
      throw new Error("Cannot mutate a time travel entity");
    }

    const entries = this.entries();
    after =
      after === undefined
        ? entries.length > 0
          ? entries.length - 1
          : 0
        : Math.max(0, after);
    let opIDBefore: OpID | "start";
    if (entries.length > 0) {
      const entryBefore = entries[after];
      if (!entryBefore) {
        throw new Error("Invalid index " + after);
      }
      opIDBefore = entryBefore.opID;
    } else {
      if (after !== 0) {
        throw new Error("Invalid index " + after);
      }
      opIDBefore = "start";
    }

    const changes = items.map((item) => ({
      op: "app",
      value: isCoValue(item) ? item.id : item,
      after: opIDBefore,
    }));

    if (opIDBefore !== "start") {
      // When added as successors we need to reverse the items
      // to keep the same insertion order
      changes.reverse();
    }

    this.core.makeTransaction(changes, privacy, meta);
    this.processNewTransactions();
  }

  /**
   * Prepends `item` before the item currently at index `before`.
   *
   * If `privacy` is `"private"` **(default)**, `item` is encrypted in the transaction, only readable by other members of the group this `CoList` belongs to. Not even sync servers can see the content in plaintext.
   *
   * If `privacy` is `"trusting"`, `item` is stored in plaintext in the transaction, visible to everyone who gets a hold of it, including sync servers.
   *
   * @category 2. Editing
   */
  prepend(
    item: Item,
    before?: number,
    privacy: "private" | "trusting" = "private",
  ) {
    if (this.isTimeTravelEntity()) {
      throw new Error("Cannot mutate a time travel entity");
    }

    const entries = this.entries();
    before = before === undefined ? 0 : before;
    let opIDAfter;
    if (entries.length > 0) {
      const entryAfter = entries[before];
      if (entryAfter) {
        opIDAfter = entryAfter.opID;
      } else {
        if (before !== entries.length) {
          throw new Error("Invalid index " + before);
        }
        opIDAfter = "end";
      }
    } else {
      if (before !== 0) {
        throw new Error("Invalid index " + before);
      }
      opIDAfter = "end";
    }
    this.core.makeTransaction(
      [
        {
          op: "pre",
          value: isCoValue(item) ? item.id : item,
          before: opIDAfter,
        },
      ],
      privacy,
    );

    this.processNewTransactions();
  }

  /** Deletes the item at index `at`.
   *
   * If `privacy` is `"private"` **(default)**, the fact of this deletion is encrypted in the transaction, only readable by other members of the group this `CoList` belongs to. Not even sync servers can see the content in plaintext.
   *
   * If `privacy` is `"trusting"`, the fact of this deletion is stored in plaintext in the transaction, visible to everyone who gets a hold of it, including sync servers.
   *
   * @category 2. Editing
   **/
  delete(at: number, privacy: "private" | "trusting" = "private") {
    if (this.isTimeTravelEntity()) {
      throw new Error("Cannot mutate a time travel entity");
    }

    const entries = this.entries();
    const entry = entries[at];
    if (!entry) {
      throw new Error("Invalid index " + at);
    }
    this.core.makeTransaction(
      [
        {
          op: "del",
          insertion: entry.opID,
        },
      ],
      privacy,
    );

    this.processNewTransactions();
  }

  replace(
    at: number,
    newItem: Item,
    privacy: "private" | "trusting" = "private",
  ) {
    if (this.isTimeTravelEntity()) {
      throw new Error("Cannot mutate a time travel entity");
    }

    const entries = this.entries();
    const entry = entries[at];
    if (!entry) {
      throw new Error("Invalid index " + at);
    }

    this.core.makeTransaction(
      [
        {
          op: "app",
          value: isCoValue(newItem) ? newItem.id : newItem,
          after: entry.opID,
        },
        {
          op: "del",
          insertion: entry.opID,
        },
      ],
      privacy,
    );
    this.processNewTransactions();
  }
}

type OpIDKey = `${string}/${number}/${number}`;

// Unlike the public `stringifyOpID` (coPlainText.ts), this key includes the
// branch, so ops from a branch and its source session can't collide.
function encodeOpID(opID: OpID): OpIDKey {
  const session = opID.branch
    ? `${opID.sessionID}_branch_${opID.branch}`
    : opID.sessionID;
  return `${session}/${opID.txIndex}/${opID.changeIdx}`;
}
