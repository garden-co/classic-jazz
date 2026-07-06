import { CoID, RawCoValue } from "../coValue.js";
import { AvailableCoValueCore } from "../coValueCore/coValueCore.js";
import { AgentID, SessionID, TransactionID } from "../ids.js";
import { JsonObject, JsonValue } from "../jsonValue.js";
import { accountOrAgentIDfromSessionID } from "../typeUtils/accountOrAgentIDfromSessionID.js";
import { isAccountID } from "../typeUtils/isAccountID.js";
import { isCoValue } from "../typeUtils/isCoValue.js";
import { RawAccountID } from "./account.js";
import { RawGroup } from "./group.js";
import { RawCoID } from "../ids.js";
import { CoValueFrontier } from "../knownState.js";

export type CoStreamItem<Item extends JsonValue> = {
  value: Item;
  tx: TransactionID;
  madeAt: number;
};

export class RawCoStreamView<
  Item extends JsonValue = JsonValue,
  Meta extends JsonObject | null = JsonObject | null,
> implements RawCoValue
{
  id: CoID<this>;
  type = "costream" as const;
  core: AvailableCoValueCore;

  /** The internal state of RawCoStream */
  items: {
    [key: SessionID]: CoStreamItem<Item>[];
  };
  knownTransactions: Record<RawCoID, number>;
  totalValidTransactions: number = 0;
  version: number = 0;

  /** @internal */
  atFrontierFilter?: CoValueFrontier = undefined;

  private resetInternalState() {
    this.items = {};
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
    this.items = {};
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
    return new RawCoStreamView(this.core, {
      atFrontierFilter: frontier,
    }) as this;
  }

  isTimeTravelEntity() {
    return Boolean(this.atFrontierFilter);
  }

  /** @internal */
  protected compareStreamItems(
    a: CoStreamItem<Item>,
    b: CoStreamItem<Item>,
  ): number {
    return (
      a.madeAt - b.madeAt ||
      (a.tx.sessionID === b.tx.sessionID
        ? 0
        : a.tx.sessionID < b.tx.sessionID
          ? -1
          : 1) ||
      a.tx.txIndex - b.tx.txIndex
    );
  }

  /** @internal */
  processNewTransactions() {
    // Session streams whose appended items arrived out of time order (rare):
    // only these need a re-sort; in-order appends keep the sorted invariant
    // by themselves.
    const unsortedEntries = new Set<CoStreamItem<Item>[]>();

    const newValidTransactions = this.core.getValidTransactions({
      ignorePrivateTransactions: false,
      knownTransactions: this.knownTransactions,
    });

    if (newValidTransactions.length === 0) {
      return;
    }

    for (const { txID, madeAt, changes } of newValidTransactions) {
      if (
        this.atFrontierFilter &&
        txID.txIndex >= (this.atFrontierFilter[txID.sessionID] ?? -1)
      ) {
        continue;
      }

      for (const changeUntyped of changes) {
        const change = changeUntyped as Item;
        let entries = this.items[txID.sessionID];
        if (!entries) {
          entries = [];
          this.items[txID.sessionID] = entries;
        }
        const item = { value: change, madeAt, tx: txID };
        const last = entries[entries.length - 1];
        if (last && this.compareStreamItems(last, item) > 0) {
          unsortedEntries.add(entries);
        }
        entries.push(item);
      }
    }

    for (const entries of unsortedEntries) {
      entries.sort(this.compareStreamItems);
    }

    this.totalValidTransactions += newValidTransactions.length;
  }

  getSingleStream(): Item[] | undefined {
    const streams = Object.values(this.items);
    const firstStream = streams[0];

    if (!firstStream) {
      return undefined;
    }

    if (streams.length > 1) {
      throw new Error(
        "CoStream.getSingleStream() can only be called when there is exactly one stream",
      );
    }

    return firstStream.map((item) => item.value);
  }

  sessions(): SessionID[] {
    return Object.keys(this.items) as SessionID[];
  }

  accounts(): Set<RawAccountID> {
    return new Set(
      this.sessions().map(accountOrAgentIDfromSessionID).filter(isAccountID),
    );
  }

  nthItemIn(
    sessionID: SessionID,
    n: number,
  ):
    | {
        by: RawAccountID | AgentID;
        tx: TransactionID;
        at: Date;
        value: Item;
      }
    | undefined {
    const items = this.items[sessionID];
    if (!items) return;

    const item = items[n];
    if (!item) return;

    return {
      by: accountOrAgentIDfromSessionID(sessionID),
      tx: item.tx,
      at: new Date(item.madeAt),
      value: item.value,
    };
  }

  lastItemIn(sessionID: SessionID):
    | {
        by: RawAccountID | AgentID;
        tx: TransactionID;
        at: Date;
        value: Item;
      }
    | undefined {
    const items = this.items[sessionID];
    if (!items) return;
    return this.nthItemIn(sessionID, items.length - 1);
  }

  *itemsIn(sessionID: SessionID) {
    const items = this.items[sessionID];
    if (!items) return;
    for (const item of items) {
      yield {
        by: accountOrAgentIDfromSessionID(sessionID),
        tx: item.tx,
        at: new Date(item.madeAt),
        value: item.value as Item,
      };
    }
  }

  lastItemBy(account: RawAccountID | AgentID):
    | {
        by: RawAccountID | AgentID;
        tx: TransactionID;
        at: Date;
        value: Item;
      }
    | undefined {
    let latestItem:
      | {
          by: RawAccountID | AgentID;
          tx: TransactionID;
          at: Date;
          value: Item;
        }
      | undefined;

    for (const sessionID of Object.keys(this.items)) {
      if (sessionID.startsWith(account)) {
        const item = this.lastItemIn(sessionID as SessionID);
        if (!item) continue;
        if (!latestItem || item.at > latestItem.at) {
          latestItem = {
            by: item.by,
            tx: item.tx,
            at: item.at,
            value: item.value,
          };
        }
      }
    }

    return latestItem;
  }

  *itemsBy(account: RawAccountID | AgentID) {
    // TODO: this can be made more lazy without a huge collect and sort
    const items = Object.keys(this.items).flatMap((sessionID) =>
      sessionID.startsWith(account)
        ? [...this.itemsIn(sessionID as SessionID)].map((item) => ({
            in: sessionID as SessionID,
            ...item,
          }))
        : [],
    );

    items.sort((a, b) => a.at.getTime() - b.at.getTime());

    for (const item of items) {
      yield item;
    }
  }

  toJSON(): {
    [key: SessionID]: Item[];
  } {
    return Object.fromEntries(
      Object.entries(this.items).map(([sessionID, items]) => [
        sessionID,
        items.map((item) => item.value),
      ]),
    );
  }

  subscribe(listener: (coStream: this) => void): () => void {
    return this.core.subscribe((core) => {
      listener(core.getCurrentContent() as this);
    });
  }
}

export class RawCoStream<
    Item extends JsonValue = JsonValue,
    Meta extends JsonObject | null = JsonObject | null,
  >
  extends RawCoStreamView<Item, Meta>
  implements RawCoValue
{
  override atFrontier(frontier: CoValueFrontier): this {
    return new RawCoStream(this.core, {
      atFrontierFilter: frontier,
    }) as this;
  }

  push(item: Item, privacy: "private" | "trusting" = "private"): void {
    if (this.isTimeTravelEntity()) {
      throw new Error("Cannot mutate a time travel entity");
    }

    this.core.makeTransaction([isCoValue(item) ? item.id : item], privacy);
    this.processNewTransactions();
  }
}
