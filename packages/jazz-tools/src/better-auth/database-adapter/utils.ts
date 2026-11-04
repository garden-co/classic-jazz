import type { CleanedWhere as BetterAuthCleanedWhere } from "better-auth/adapters";

export type CleanedWhere = Omit<BetterAuthCleanedWhere, "mode"> & {
  mode?: "sensitive" | "insensitive";
};

export function filterListByWhere<T>(
  data: T[],
  where: CleanedWhere[] | undefined,
): T[] {
  if (!Array.isArray(data)) {
    throw new Error("Expected data to be an array");
  }

  if (where === undefined) {
    return data;
  }

  if (!Array.isArray(where)) {
    throw new Error("Expected where to be an array");
  }

  // Helper to evaluate a single condition
  function evaluateCondition(item: any, condition: CleanedWhere): boolean {
    const { field, operator } = condition;
    let value = condition.value;
    let itemValue = field === "id" ? item.$jazz.id : item[field];
    if (condition.mode === "insensitive") {
      if (typeof itemValue === "string") itemValue = itemValue.toLowerCase();
      if (typeof value === "string") value = value.toLowerCase();
      else if (
        Array.isArray(value) &&
        value.every((entry) => typeof entry === "string")
      ) {
        value = value.map((entry) => entry.toLowerCase());
      }
    }

    switch (operator) {
      case "eq":
        return itemValue === value;
      case "ne":
        return itemValue !== value;
      case "lt":
        return value !== null && itemValue < value;
      case "lte":
        return value !== null && itemValue <= value;
      case "gt":
        return value !== null && itemValue > value;
      case "gte":
        return value !== null && itemValue >= value;
      case "in":
        return Array.isArray(value)
          ? (value as (string | number | boolean | Date)[]).includes(itemValue)
          : false;
      case "not_in":
        return Array.isArray(value)
          ? !(value as (string | number | boolean | Date)[]).includes(itemValue)
          : false;
      case "contains":
        return typeof itemValue === "string" && typeof value === "string"
          ? itemValue.includes(value)
          : false;
      case "starts_with":
        return typeof itemValue === "string" && typeof value === "string"
          ? itemValue.startsWith(value)
          : false;
      case "ends_with":
        return typeof itemValue === "string" && typeof value === "string"
          ? itemValue.endsWith(value)
          : false;
      default:
        throw new Error(`Unsupported operator: ${operator}`);
    }
  }

  // Group conditions by connector (AND/OR)
  // If no connector, default to AND between all
  return data.filter((item) => {
    let result: boolean = true;
    for (let i = 0; i < where.length; i++) {
      const condition = where[i]!;
      const matches = evaluateCondition(item, condition);
      if (i === 0) {
        result = matches;
      } else {
        const connector = condition.connector || "AND";
        if (connector === "AND") {
          result = result && matches;
        } else if (connector === "OR") {
          result = result || matches;
        } else {
          throw new Error(`Unsupported connector: ${connector}`);
        }
      }
    }
    return result;
  });
}

export function sortListByField<T extends Record<string, any> | null>(
  data: T[],
  sort?: { field: string; direction: "asc" | "desc" },
): T[] {
  if (!sort) {
    return data;
  }

  const { field, direction } = sort;

  data.sort((a, b) => {
    if (a === null || b === null) {
      return 0;
    }

    if (typeof a[field] === "string" && typeof b[field] === "string") {
      return direction === "asc"
        ? a[field].localeCompare(b[field])
        : b[field].localeCompare(a[field]);
    }

    return direction === "asc" ? a[field] - b[field] : b[field] - a[field];
  });

  return data;
}

export function paginateList<T>(
  data: T[],
  limit: number | undefined,
  offset: number | undefined,
): T[] {
  if (offset === undefined && limit === undefined) {
    return data;
  }

  if (limit === 0) {
    return [];
  }

  let start = offset ?? 0;
  if (start < 0) {
    start = 0;
  }

  const end = limit ? start + limit : undefined;
  return data.slice(start, end);
}

function isWhereByField(field: string, where: CleanedWhere): boolean {
  return (
    where.field === field &&
    where.mode !== "insensitive" &&
    where.operator === "eq" &&
    where.connector === "AND"
  );
}

export function isWhereBySingleField<T extends string>(
  field: T,
  where: CleanedWhere[] | undefined,
): where is [{ field: T; operator: "eq"; value: string; connector: "AND" }] {
  if (where === undefined || where.length !== 1) {
    return false;
  }

  const [cond] = where;
  if (!cond) {
    return false;
  }

  return isWhereByField(field, cond);
}

export function containWhereByField<T extends string>(
  field: T,
  where: CleanedWhere[] | undefined,
): boolean {
  if (where === undefined) {
    return false;
  }

  return where.some((cond) => isWhereByField(field, cond));
}

export function extractWhereByField<T extends string>(
  field: T,
  where: CleanedWhere[] | undefined,
): [CleanedWhere | undefined, CleanedWhere[]] {
  if (where === undefined) {
    return [undefined, []];
  }

  return [
    where.find((cond) => isWhereByField(field, cond)),
    where.filter((cond) => !isWhereByField(field, cond)),
  ];
}
