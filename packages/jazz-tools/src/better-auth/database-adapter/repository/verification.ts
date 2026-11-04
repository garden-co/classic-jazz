import type { CleanedWhere } from "../utils.js";
import { JazzRepository } from "./generic";
import { isWhereBySingleField } from "../utils";
import type { TableItem } from "../schema";

export class VerificationRepository extends JazzRepository {
  /**
   * Custom logic: property identifier is used as uniqueId
   */
  async create(
    model: string,
    data: Record<string, any>,
    uniqueId?: string,
  ): Promise<TableItem> {
    return super.create(model, data, data["identifier"]);
  }

  /**
   * Custom logic: property identifier is used as uniqueId
   * If we look for identifier, we use findByUnique instead of findMany
   */
  async findMany(
    model: string,
    where: CleanedWhere[] | undefined,
    limit?: number,
    sortBy?: { field: string; direction: "asc" | "desc" },
    offset?: number,
  ): Promise<TableItem[]> {
    if (isWhereBySingleField("identifier", where)) {
      return this.findByUnique(model, where).then((node) =>
        node ? [node] : [],
      );
    }

    return super.findMany(model, where, limit, sortBy, offset);
  }
}
