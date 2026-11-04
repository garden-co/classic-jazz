import type { CleanedWhere } from "../utils.js";
import { co, z } from "jazz-tools";
import { JazzRepository } from "./generic";
import { isWhereBySingleField } from "../utils";
import type { TableItem } from "../schema";

/**
 * This list stores an array of covalues ID
 * mapped by the accountID property.
 * Because accountId is not unique, and it is used on every social login
 */
const AccountIdIndex = co.list(z.string());

export class AccountRepository extends JazzRepository {
  /**
   * Custom logic:
   * - keep sync accountId index
   */
  async create(
    model: string,
    data: Record<string, any>,
    uniqueId?: string,
  ): Promise<TableItem> {
    const account = await super.create(model, data, uniqueId);

    await this.updateAccountIdIndex(
      account[this.getAccountIdProperty()],
      account.$jazz.id,
    );

    return account;
  }

  /**
   * Custom logic:
   * - if the accountId is in the where clause, get the ids from the index
   */
  async findMany(
    model: string,
    where: CleanedWhere[] | undefined,
    limit?: number,
    sortBy?: { field: string; direction: "asc" | "desc" },
    offset?: number,
  ): Promise<TableItem[]> {
    if (isWhereBySingleField(this.getAccountIdProperty(), where)) {
      const accountIdIndex = await this.getAccountIdIndex(where[0].value);

      const ids = accountIdIndex.$isLoaded ? accountIdIndex : [];

      if (ids.length === 0) {
        return [];
      }

      // except for accountId clashing from different social providers,
      // ids should contain a single id, max two
      const results = await Promise.all(
        ids.map((id) =>
          super.findById(model, [
            { field: "id", operator: "eq", value: id, connector: "AND" },
          ]),
        ),
      );

      return results.filter((value) => value !== null);
    }

    return super.findMany(model, where, limit, sortBy, offset);
  }

  async deleteValue(model: string, where: CleanedWhere[]): Promise<number> {
    const nodes = await this.findMany(model, where);

    const deleted = await super.deleteValue(model, where);

    for (const node of nodes) {
      const accountId = node.$jazz.raw.get(this.getAccountIdProperty()) as
        | string
        | undefined;

      if (accountId) {
        await this.deleteAccountIdIndex(accountId, node.$jazz.id);
      }
    }

    return deleted;
  }

  private async getAccountIdIndex(accountId: string) {
    const indexUnique = this.getAccountIdProperty() + "_" + accountId;

    const accountIdIndex = await AccountIdIndex.loadUnique(
      indexUnique,
      this.owner.$jazz.id,
      {
        loadAs: this.worker,
      },
    );

    return accountIdIndex;
  }

  private async updateAccountIdIndex(accountId: string, entityId: string) {
    const accountIdIndex = await this.getAccountIdIndex(accountId);

    const ids = accountIdIndex.$isLoaded ? accountIdIndex : [];

    await AccountIdIndex.upsertUnique({
      value: [...ids, entityId],
      unique: this.getAccountIdProperty() + "_" + accountId,
      owner: this.owner,
    });
  }

  private async deleteAccountIdIndex(accountId: string, entityId: string) {
    const accountIdIndex = await this.getAccountIdIndex(accountId);

    const ids = accountIdIndex.$isLoaded ? accountIdIndex : [];

    await AccountIdIndex.upsertUnique({
      value: ids.filter((id) => id !== entityId),
      unique: this.getAccountIdProperty() + "_" + accountId,
      owner: this.owner,
    });
  }

  private getAccountIdProperty(): string {
    return (
      this.betterAuthSchema.account?.fields.accountId?.fieldName || "accountId"
    );
  }
}
