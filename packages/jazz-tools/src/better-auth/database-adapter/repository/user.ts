import type { CleanedWhere } from "../utils.js";
import { co, z } from "jazz-tools";
import { JazzRepository } from "./generic";
import { isWhereBySingleField } from "../utils";
import type { TableItem } from "../schema";

const EmailIndex = co.map({ user: z.string().nullable() });

export class UserRepository extends JazzRepository {
  /**
   * Custom logic:
   * - sessions are stored inside the user object
   * - keep sync email index
   */
  async create(
    model: string,
    data: Record<string, any>,
    uniqueId?: string,
  ): Promise<TableItem> {
    const SessionListSchema = this.databaseSchema.shape.tables.shape.session;

    if (!SessionListSchema) {
      throw new Error("Session list schema not found");
    }

    const userEmail = data[this.getEmailProperty()] as string;

    const emailIndex = await this.loadEmailIndex(userEmail);

    if (emailIndex.$isLoaded && emailIndex.user) {
      throw new Error("Email already exists");
    }

    const user = await super.create(
      model,
      {
        sessions: [],
        ...data,
      },
      uniqueId,
    );

    await this.updateEmailIndex(userEmail, user.$jazz.id);

    user.$jazz.set(
      "sessions",
      co.list(SessionListSchema).create([], user.$jazz.owner),
    );

    return user;
  }

  /**
   * Custom logic:
   * - if the email is in the where clause, find by email
   */
  async findMany(
    model: string,
    where: CleanedWhere[] | undefined,
    limit?: number,
    sortBy?: { field: string; direction: "asc" | "desc" },
    offset?: number,
  ): Promise<TableItem[]> {
    if (isWhereBySingleField("email", where)) {
      return this.findByEmail(where[0].value as string);
    }

    return super.findMany(model, where, limit, sortBy, offset);
  }

  private getEmailProperty(): string {
    return this.betterAuthSchema.user?.fields.email?.fieldName || "email";
  }

  private async findByEmail(email: string): Promise<TableItem[]> {
    const emailIndex = await this.loadEmailIndex(email);

    if (!emailIndex.$isLoaded) {
      return [];
    }

    const user = emailIndex.user;

    if (!user) {
      return [];
    }

    return this.findById("user", [
      { field: "id", operator: "eq", value: user, connector: "AND" },
    ]).then((user) => (user ? [user] : []));
  }

  /**
   * Custom logic:
   * - if the email is changed, update the email index
   */
  async update(
    model: string,
    where: CleanedWhere[],
    update: Record<string, any>,
  ): Promise<TableItem[]> {
    const nodes = await this.findMany(model, where);
    if (nodes.length === 0) {
      return [];
    }

    const newEmail = (update as Record<string, any>)[this.getEmailProperty()] as
      | string
      | undefined;

    for (const node of nodes) {
      const oldEmail = node.$jazz.raw.get(this.getEmailProperty()) as
        | string
        | undefined;
      for (const [key, value] of Object.entries(
        update as Record<string, any>,
      )) {
        node.$jazz.set(key, value);
      }

      // if the email is changed, update the email index
      if (
        oldEmail !== newEmail &&
        oldEmail !== undefined &&
        newEmail !== undefined
      ) {
        await this.updateEmailIndex(oldEmail, null);
        await this.updateEmailIndex(newEmail, node.$jazz.id);
      }
    }

    return nodes;
  }

  async deleteValue(model: string, where: CleanedWhere[]): Promise<number> {
    const nodes = await this.findMany(model, where);

    const deleted = await super.deleteValue(model, where);

    for (const node of nodes) {
      const email = node.$jazz.raw.get(this.getEmailProperty()) as
        | string
        | undefined;
      if (email) {
        await this.updateEmailIndex(email, null);
      }
    }

    return deleted;
  }

  private async loadEmailIndex(email: string) {
    const emailIndex = await EmailIndex.loadUnique(email, this.owner.$jazz.id, {
      loadAs: this.worker,
    });

    return emailIndex;
  }

  private async updateEmailIndex(email: string, userId: string | null) {
    await EmailIndex.upsertUnique({
      value: {
        user: userId,
      },
      unique: email,
      owner: this.owner,
    });
  }
}
