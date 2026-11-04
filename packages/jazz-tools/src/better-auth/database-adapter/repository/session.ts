import { BetterAuthDBSchema } from "better-auth/db";
import type { CleanedWhere } from "../utils.js";
import { co, Account } from "jazz-tools";
import { JazzRepository } from "./generic";
import { UserRepository } from "./user";
import {
  containWhereByField,
  extractWhereByField,
  filterListByWhere,
  isWhereBySingleField,
} from "../utils";
import type { Database, TableItem } from "../schema";

type UserSchema = co.Map<{
  sessions: co.List<co.Map<any>>;
}>;

export class SessionRepository extends JazzRepository {
  protected userRepository: UserRepository;

  constructor(
    databaseSchema: Database,
    databaseRoot: co.loaded<Database, { group: true }>,
    worker: Account,
    betterAuthSchema: BetterAuthDBSchema = {},
    ensureSync: boolean = false,
  ) {
    super(databaseSchema, databaseRoot, worker, betterAuthSchema, ensureSync);

    this.userRepository = new UserRepository(
      databaseSchema,
      databaseRoot,
      worker,
      betterAuthSchema,
    );
  }

  /**
   * Custom logic: sessions are stored inside the user object
   */
  async create(
    model: string,
    data: Record<string, any>,
    uniqueId?: string,
  ): Promise<TableItem> {
    if (typeof data.token !== "string" || typeof data.userId !== "string") {
      throw new Error("Token and userId are required for session creation");
    }

    const user = await this.userRepository.findById("user", [
      {
        field: "id",
        operator: "eq",
        value: data.userId,
        connector: "AND",
      },
    ]);

    if (!user) {
      throw new Error("User not found");
    }

    const { sessions } = await user.$jazz.ensureLoaded({
      resolve: {
        sessions: true,
      },
    });

    const session = this.getSchema("session").create(
      {
        ...data,
        _deleted: false,
      },
      {
        unique: data.token,
        owner: this.owner,
      },
    );

    sessions.$jazz.push(session);

    return session;
  }

  /**
   * Custom logic: sessions are stored inside the user object.
   */
  async findMany(
    model: string,
    where: CleanedWhere[] | undefined,
    limit?: number,
    sortBy?: { field: string; direction: "asc" | "desc" },
    offset?: number,
  ): Promise<TableItem[]> {
    if (isWhereBySingleField("id", where)) {
      return this.findById(model, where).then((node) => (node ? [node] : []));
    }

    if (isWhereBySingleField("token", where)) {
      return this.findByUnique(model, where).then((node) =>
        node ? [node] : [],
      );
    }

    if (containWhereByField("userId", where)) {
      const [userIdWhere, otherWhere] = extractWhereByField("userId", where);

      const user = await this.userRepository.findById("user", [
        {
          field: "id",
          operator: "eq",
          value: userIdWhere!.value as string,
          connector: "AND",
        },
      ]);

      if (!user) {
        console.warn("Trying to find user's sessions, but user not found");
        return [];
      }

      const { sessions } = await user.$jazz.ensureLoaded({
        resolve: {
          sessions: {
            $each: true,
          },
        },
      });

      return this.filterSortPaginateList(
        sessions,
        otherWhere,
        limit,
        sortBy,
        offset,
      );
    }

    const users = await this.userRepository.findMany("user", undefined);
    const sessions: TableItem[] = [];
    for (const user of users) {
      const loaded = await user.$jazz.ensureLoaded({
        resolve: { sessions: { $each: true } },
      });
      sessions.push(...loaded.sessions);
    }

    return this.filterSortPaginateList(sessions, where, limit, sortBy, offset);
  }

  /**
   * Custom logic: sessions are stored inside the user object.
   */
  async deleteValue(model: string, where: CleanedWhere[]): Promise<number> {
    const items = await this.findMany(model, where);
    if (items.length === 0) {
      return 0;
    }

    const sessionsByUser = new Map<string, TableItem[]>();
    for (const item of items) {
      const sessions = sessionsByUser.get(item.userId) ?? [];
      sessions.push(item);
      sessionsByUser.set(item.userId, sessions);
    }
    let deleted = 0;
    for (const [userId, sessions] of sessionsByUser) {
      deleted += await this.deleteSession(userId, sessions);
    }
    return deleted;
  }

  private async deleteSession(
    userId: string,
    items: TableItem[],
  ): Promise<number> {
    const user = await this.userRepository.findById("user", [
      {
        field: "id",
        operator: "eq",
        value: userId,
        connector: "AND",
      },
    ]);

    if (!user) {
      throw new Error("User not found");
    }

    const { sessions } = await user.$jazz.ensureLoaded({
      resolve: {
        sessions: true,
      },
    });

    for (const toBeDeleted of items) {
      // Get entries without trigger the shallow load
      const index = [...sessions.entries()].findIndex(
        ([_, value]) => value && value.$jazz.id === toBeDeleted.$jazz.id,
      );

      toBeDeleted.$jazz.set("_deleted", true);

      if (index !== -1) {
        sessions.$jazz.remove(index);
      }
    }

    return items.length;
  }
}
