import type { CleanedWhere } from "../utils.js";
import { BetterAuthDBSchema } from "better-auth/db";
import { Account, CoList, CoMap, Group, co } from "jazz-tools";
import type { Database, TableItem } from "../schema.js";
import {
  filterListByWhere,
  isWhereBySingleField,
  paginateList,
  sortListByField,
} from "../utils.js";

export class JazzRepository {
  protected databaseSchema: Database;
  protected databaseRoot: co.loaded<Database, { group: true }>;
  protected worker: Account;
  protected owner: Group;
  protected betterAuthSchema: BetterAuthDBSchema;

  private coValuesTracker:
    | {
        done: () => Set<`co_z${string}`>;
      }
    | undefined = undefined;

  constructor(
    databaseSchema: Database,
    databaseRoot: co.loaded<Database, { group: true }>,
    worker: Account,
    betterAuthSchema: BetterAuthDBSchema = {},
    ensureSync: boolean = false,
  ) {
    this.databaseSchema = databaseSchema;
    this.databaseRoot = databaseRoot;
    this.worker = worker;
    this.owner = databaseRoot.group;
    this.betterAuthSchema = betterAuthSchema;

    if (ensureSync)
      this.coValuesTracker =
        worker.$jazz.raw.core.node.syncManager.trackDirtyCoValues();
  }

  ensureSync() {
    if (!this.coValuesTracker)
      throw new Error("Repository wasn't initialized with ensureSync option");

    return Promise.all(
      Array.from(this.coValuesTracker.done(), (id) =>
        this.worker.$jazz.raw.core.node.syncManager.waitForSync(id),
      ),
    );
  }

  async create(
    model: string,
    data: Record<string, any>,
    uniqueId?: string,
  ): Promise<TableItem> {
    const schema = this.getSchema(model);

    const resolved = await this.databaseRoot.$jazz.ensureLoaded({
      resolve: {
        tables: {
          [model]: true,
        },
      },
    });

    const list = resolved.tables?.[model] as unknown as CoList<CoMap>;

    if (!uniqueId) {
      // Use the same owner of the table.
      const node = schema.create(
        {
          ...data,
          _deleted: false,
        },
        {
          owner: list.$jazz.owner,
        },
      );

      list.$jazz.push(node);

      return node;
    }

    // If we have a unique id, we must check for soft deleted items first
    const existingNode = await schema.loadUnique(
      uniqueId,
      list.$jazz.owner.$jazz.id,
      {
        loadAs: this.worker,
      },
    );

    // if the entity exists and is not soft deleted, we must throw an error
    if (
      existingNode.$isLoaded &&
      existingNode.$jazz.raw.get("_deleted") !== true
    ) {
      throw new Error("Entity already exists");
    }

    // create the entity or update the deleted one
    const node = await schema.upsertUnique({
      value: {
        ...data,
        _deleted: false,
      },
      owner: list.$jazz.owner,
      unique: uniqueId,
    });

    if (!node.$isLoaded) {
      throw new Error("Unable to create entity");
    }

    list.$jazz.push(node);

    return node;
  }

  async findOne(
    model: string,
    where: CleanedWhere[],
  ): Promise<TableItem | null> {
    return this.findMany(model, where, 1).then((users) => users?.at(0) ?? null);
  }

  async findById(
    model: string,
    where: [{ field: "id"; operator: "eq"; value: string; connector: "AND" }],
  ): Promise<TableItem | null> {
    const id = where[0]!.value;

    if (!id.startsWith("co_")) {
      return null;
    }

    const node = await this.getSchema(model).load(id, { loadAs: this.worker });

    if (!node.$isLoaded) {
      return null;
    }

    if (node.$jazz.raw.get("_deleted")) {
      return null;
    }

    return node;
  }

  async findByUnique(
    model: string,
    where: [{ field: string; operator: "eq"; value: string; connector: "AND" }],
  ): Promise<TableItem | null> {
    const value = where[0]!.value;

    const node = await this.getSchema(model).loadUnique(
      value,
      this.owner.$jazz.id,
      {
        loadAs: this.worker,
      },
    );

    if (!node.$isLoaded) {
      return null;
    }

    if (node.$jazz.raw.get("_deleted")) {
      return null;
    }

    return node;
  }

  async findMany(
    model: string,
    where: CleanedWhere[] | undefined,
    limit?: number,
    sortBy?: { field: string; direction: "asc" | "desc" },
    offset?: number,
  ): Promise<TableItem[]> {
    // ensure schema exists
    this.getSchema(model);

    if (isWhereBySingleField("id", where)) {
      return this.findById(model, where).then((node) => (node ? [node] : []));
    }

    const resolvedRoot = await this.databaseRoot.$jazz.ensureLoaded({
      resolve: {
        tables: {
          [model]: {
            $each: true,
          },
        },
      },
    });

    const list = resolvedRoot.tables?.[model] as CoList<CoMap> | undefined;

    if (!list) {
      return [];
    }

    return this.filterSortPaginateList(list, where, limit, sortBy, offset);
  }

  async update(
    model: string,
    where: CleanedWhere[],
    update: Record<string, any>,
  ): Promise<TableItem[]> {
    const nodes = await this.findMany(model, where);

    if (nodes.length === 0) {
      return [];
    }

    for (const node of nodes) {
      for (const [key, value] of Object.entries(
        update as Record<string, any>,
      )) {
        node.$jazz.set(key, value);
      }
    }

    return nodes;
  }

  async deleteValue(model: string, where: CleanedWhere[]): Promise<number> {
    const items = await this.findMany(model, where);

    if (items.length === 0) {
      return 0;
    }

    const resolved = await this.databaseRoot.$jazz.ensureLoaded({
      resolve: {
        tables: {
          [model]: {
            $each: true,
          },
        },
      },
    });

    if (!resolved) {
      throw new Error("Unable to load values");
    }

    const list = resolved?.tables?.[model] as unknown as CoList<CoMap>;

    for (const toBeDeleted of items) {
      // Get entries without trigger the shallow load
      const index = [...list.entries()].findIndex(
        ([_, value]) => value && value.$jazz.id === toBeDeleted.$jazz.id,
      );

      toBeDeleted.$jazz.set("_deleted", true);

      if (index !== -1) {
        list.$jazz.remove(index);
      }
    }

    return items.length;
  }

  async count(
    model: string,
    where: CleanedWhere[] | undefined,
  ): Promise<number> {
    return this.findMany(model, where).then((values) => values.length);
  }

  protected getSchema(model: string) {
    const schema = this.databaseSchema.shape.tables.shape[model]?.element;
    if (!schema) {
      throw new Error(`Schema for model "${model}" not found`);
    }
    return schema;
  }

  protected filterSortPaginateList<T extends TableItem>(
    list: Iterable<CoMap | null>,
    where: CleanedWhere[] | undefined,
    limit?: number,
    sortBy?: { field: string; direction: "asc" | "desc" },
    offset?: number,
  ): T[] {
    // ignore nullable values and soft deleted items
    return [
      [...list].filter(
        (item) => item !== null && item.$jazz.raw.get("_deleted") !== true,
      ),
    ]
      .map((list) => filterListByWhere(list, where))
      .map((list) => sortListByField(list, sortBy))
      .map((list) => paginateList(list, limit, offset))
      .at(0)! as T[];
  }
}
