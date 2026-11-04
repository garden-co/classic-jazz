import type { CleanedWhere } from "../utils.js";
import { describe, expect, it } from "vitest";
import {
  filterListByWhere,
  isWhereBySingleField,
  paginateList,
  sortListByField,
} from "../utils.js";

describe("filterListByWhere", () => {
  const testData = [
    { id: 1, name: "Alice", age: 25, email: "alice@example.com", active: true },
    { id: 2, name: "Bob", age: 30, email: "bob@example.com", active: false },
    {
      id: 3,
      name: "Charlie",
      age: 35,
      email: "charlie@example.com",
      active: true,
    },
    { id: 4, name: "David", age: 28, email: "david@test.com", active: true },
    { id: 5, name: "Eve", age: 22, email: "eve@example.com", active: false },
  ];

  it.each(["eq", "contains", "starts_with", "ends_with", "in"] as const)(
    "honors insensitive mode for %s",
    (operator) => {
      const value = operator === "in" ? ["ALICE"] : "ALICE";
      expect(
        filterListByWhere(testData, [
          {
            field: "name",
            operator,
            value,
            connector: "AND",
            mode: "insensitive",
          },
        ]),
      ).toEqual([testData[0]]);
      expect(
        filterListByWhere(testData, [
          {
            field: "name",
            operator,
            value,
            connector: "AND",
            mode: "sensitive",
          },
        ]),
      ).toEqual([]);
    },
  );

  it("does not use an exact lookup for an insensitive query", () => {
    expect(
      isWhereBySingleField("email", [
        {
          field: "email",
          operator: "eq",
          value: "ALICE@example.com",
          connector: "AND",
          mode: "insensitive",
        },
      ]),
    ).toBe(false);
  });

  describe("basic functionality", () => {
    it("should return all data when where is undefined", () => {
      const result = filterListByWhere(testData, undefined);
      expect(result).toEqual(testData);
    });

    it("should return all data when where is empty array", () => {
      const result = filterListByWhere(testData, []);
      expect(result).toEqual(testData);
    });

    it("should throw error when data is not an array", () => {
      expect(() => filterListByWhere(null as any, [])).toThrow(
        "Expected data to be an array",
      );
      expect(() => filterListByWhere(undefined as any, [])).toThrow(
        "Expected data to be an array",
      );
      expect(() => filterListByWhere("string" as any, [])).toThrow(
        "Expected data to be an array",
      );
    });

    it("should throw error when where is not an array", () => {
      expect(() => filterListByWhere(testData, null as any)).toThrow(
        "Expected where to be an array",
      );
      expect(() => filterListByWhere(testData, "string" as any)).toThrow(
        "Expected where to be an array",
      );
    });
  });

  describe("equality operators", () => {
    it("should filter with eq operator", () => {
      const where: CleanedWhere[] = [
        { field: "name", operator: "eq", value: "Alice", connector: "AND" },
      ];
      const result = filterListByWhere(testData, where);
      expect(result).toEqual([
        {
          id: 1,
          name: "Alice",
          age: 25,
          email: "alice@example.com",
          active: true,
        },
      ]);
    });

    it("should filter with ne operator", () => {
      const where: CleanedWhere[] = [
        { field: "name", operator: "ne", value: "Alice", connector: "AND" },
      ];
      const result = filterListByWhere(testData, where);
      expect(result).toHaveLength(4);
      expect(result.every((item) => item.name !== "Alice")).toBe(true);
    });

    it("should handle null values correctly", () => {
      const dataWithNull = [
        { id: 1, name: "Alice", age: null },
        { id: 2, name: "Bob", age: 30 },
      ];
      const where: CleanedWhere[] = [
        { field: "age", operator: "eq", value: null, connector: "AND" },
      ];
      const result = filterListByWhere(dataWithNull, where);
      expect(result).toEqual([{ id: 1, name: "Alice", age: null }]);
    });
  });

  describe("comparison operators", () => {
    it("should filter with lt operator", () => {
      const where: CleanedWhere[] = [
        { field: "age", operator: "lt", value: 30, connector: "AND" },
      ];
      const result = filterListByWhere(testData, where);
      expect(result).toEqual([
        {
          id: 1,
          name: "Alice",
          age: 25,
          email: "alice@example.com",
          active: true,
        },
        {
          id: 4,
          name: "David",
          age: 28,
          email: "david@test.com",
          active: true,
        },
        {
          id: 5,
          name: "Eve",
          age: 22,
          email: "eve@example.com",
          active: false,
        },
      ]);
    });

    it("should filter with lte operator", () => {
      const where: CleanedWhere[] = [
        { field: "age", operator: "lte", value: 30, connector: "AND" },
      ];
      const result = filterListByWhere(testData, where);
      expect(result).toEqual([
        {
          id: 1,
          name: "Alice",
          age: 25,
          email: "alice@example.com",
          active: true,
        },
        {
          id: 2,
          name: "Bob",
          age: 30,
          email: "bob@example.com",
          active: false,
        },
        {
          id: 4,
          name: "David",
          age: 28,
          email: "david@test.com",
          active: true,
        },
        {
          id: 5,
          name: "Eve",
          age: 22,
          email: "eve@example.com",
          active: false,
        },
      ]);
    });

    it("should filter with gt operator", () => {
      const where: CleanedWhere[] = [
        { field: "age", operator: "gt", value: 30, connector: "AND" },
      ];
      const result = filterListByWhere(testData, where);
      expect(result).toEqual([
        {
          id: 3,
          name: "Charlie",
          age: 35,
          email: "charlie@example.com",
          active: true,
        },
      ]);
    });

    it("should filter with gte operator", () => {
      const where: CleanedWhere[] = [
        { field: "age", operator: "gte", value: 30, connector: "AND" },
      ];
      const result = filterListByWhere(testData, where);
      expect(result).toEqual([
        {
          id: 2,
          name: "Bob",
          age: 30,
          email: "bob@example.com",
          active: false,
        },
        {
          id: 3,
          name: "Charlie",
          age: 35,
          email: "charlie@example.com",
          active: true,
        },
      ]);
    });

    it("should handle null values in comparison operators", () => {
      const where: CleanedWhere[] = [
        { field: "age", operator: "lt", value: null, connector: "AND" },
      ];
      const result = filterListByWhere(testData, where);
      expect(result).toEqual([]);
    });
  });

  describe("string operators", () => {
    it("should filter with contains operator", () => {
      const where: CleanedWhere[] = [
        {
          field: "email",
          operator: "contains",
          value: "test",
          connector: "AND",
        },
      ];
      const result = filterListByWhere(testData, where);
      expect(result).toEqual([
        {
          id: 4,
          name: "David",
          age: 28,
          email: "david@test.com",
          active: true,
        },
      ]);
    });

    it("should filter with starts_with operator", () => {
      const where: CleanedWhere[] = [
        {
          field: "name",
          operator: "starts_with",
          value: "A",
          connector: "AND",
        },
      ];
      const result = filterListByWhere(testData, where);
      expect(result).toEqual([
        {
          id: 1,
          name: "Alice",
          age: 25,
          email: "alice@example.com",
          active: true,
        },
      ]);
    });

    it("should filter with ends_with operator", () => {
      const where: CleanedWhere[] = [
        { field: "name", operator: "ends_with", value: "e", connector: "AND" },
      ];
      const result = filterListByWhere(testData, where);
      expect(result).toEqual([
        {
          id: 1,
          name: "Alice",
          age: 25,
          email: "alice@example.com",
          active: true,
        },
        {
          id: 3,
          name: "Charlie",
          age: 35,
          email: "charlie@example.com",
          active: true,
        },
        {
          id: 5,
          name: "Eve",
          age: 22,
          email: "eve@example.com",
          active: false,
        },
      ]);
    });

    it("should handle non-string values in string operators", () => {
      const where: CleanedWhere[] = [
        { field: "age", operator: "contains", value: "test", connector: "AND" },
      ];
      const result = filterListByWhere(testData, where);
      expect(result).toEqual([]);
    });
  });

  describe("in operator", () => {
    it("should filter with in operator for strings", () => {
      const where: CleanedWhere[] = [
        {
          field: "name",
          operator: "in",
          value: ["Alice", "Bob"],
          connector: "AND",
        },
      ];
      const result = filterListByWhere(testData, where);
      expect(result).toEqual([
        {
          id: 1,
          name: "Alice",
          age: 25,
          email: "alice@example.com",
          active: true,
        },
        {
          id: 2,
          name: "Bob",
          age: 30,
          email: "bob@example.com",
          active: false,
        },
      ]);
    });

    it("should filter with in operator for numbers", () => {
      const where: CleanedWhere[] = [
        { field: "age", operator: "in", value: [25, 30, 35], connector: "AND" },
      ];
      const result = filterListByWhere(testData, where);
      expect(result).toEqual([
        {
          id: 1,
          name: "Alice",
          age: 25,
          email: "alice@example.com",
          active: true,
        },
        {
          id: 2,
          name: "Bob",
          age: 30,
          email: "bob@example.com",
          active: false,
        },
        {
          id: 3,
          name: "Charlie",
          age: 35,
          email: "charlie@example.com",
          active: true,
        },
      ]);
    });

    it("should filter with in operator for booleans", () => {
      const where: CleanedWhere[] = [
        {
          field: "active",
          operator: "in",
          value: [true] as any,
          connector: "AND",
        },
      ];
      const result = filterListByWhere(testData, where);
      expect(result).toEqual([
        {
          id: 1,
          name: "Alice",
          age: 25,
          email: "alice@example.com",
          active: true,
        },
        {
          id: 3,
          name: "Charlie",
          age: 35,
          email: "charlie@example.com",
          active: true,
        },
        {
          id: 4,
          name: "David",
          age: 28,
          email: "david@test.com",
          active: true,
        },
      ]);
    });

    it("should handle non-array values in in operator", () => {
      const where: CleanedWhere[] = [
        {
          field: "name",
          operator: "in",
          value: "Alice" as any,
          connector: "AND",
        },
      ];
      const result = filterListByWhere(testData, where);
      expect(result).toEqual([]);
    });
  });

  describe("connectors", () => {
    it("should use explicit AND connector", () => {
      const where: CleanedWhere[] = [
        { field: "age", operator: "gte", value: 25, connector: "AND" },
        { field: "active", operator: "eq", value: true, connector: "AND" },
      ];
      const result = filterListByWhere(testData, where);
      expect(result).toEqual([
        {
          id: 1,
          name: "Alice",
          age: 25,
          email: "alice@example.com",
          active: true,
        },
        {
          id: 3,
          name: "Charlie",
          age: 35,
          email: "charlie@example.com",
          active: true,
        },
        {
          id: 4,
          name: "David",
          age: 28,
          email: "david@test.com",
          active: true,
        },
      ]);
    });

    it("should use OR connector", () => {
      const where: CleanedWhere[] = [
        { field: "age", operator: "lt", value: 25, connector: "OR" },
        { field: "active", operator: "eq", value: false, connector: "OR" },
      ];
      const result = filterListByWhere(testData, where);
      expect(result).toEqual([
        {
          id: 2,
          name: "Bob",
          age: 30,
          email: "bob@example.com",
          active: false,
        },
        {
          id: 5,
          name: "Eve",
          age: 22,
          email: "eve@example.com",
          active: false,
        },
      ]);
    });

    it("should throw error for unsupported connector", () => {
      const where: CleanedWhere[] = [
        { field: "name", operator: "eq", value: "Alice", connector: "AND" },
        { field: "age", operator: "eq", value: 25, connector: "XOR" as any },
      ];
      expect(() => filterListByWhere(testData, where)).toThrow(
        "Unsupported connector: XOR",
      );
    });
  });

  describe("error handling", () => {
    it("should throw error for unsupported operator", () => {
      const where: CleanedWhere[] = [
        {
          field: "name",
          operator: "unsupported" as any,
          value: "Alice",
          connector: "AND",
        },
      ];
      expect(() => filterListByWhere(testData, where)).toThrow(
        "Unsupported operator: unsupported",
      );
    });
  });
});

describe("filterListByWhere with id => $jazz.id", () => {
  const testData = [
    { $jazz: { id: "a1" }, name: "Alice", age: 25, active: true },
    { $jazz: { id: "b2" }, name: "Bob", age: 30, active: false },
    { $jazz: { id: "c3" }, name: "Charlie", age: 35, active: true },
  ] as any[];

  it("should match by $jazz.id when where field is 'id' (eq)", () => {
    const where: CleanedWhere[] = [
      { field: "id", operator: "eq", value: "a1", connector: "AND" },
    ];
    const result = filterListByWhere(testData, where);
    expect(result).toEqual([
      { $jazz: { id: "a1" }, name: "Alice", age: 25, active: true },
    ]);
  });

  it("should return empty when no $jazz.id matches", () => {
    const where: CleanedWhere[] = [
      { field: "id", operator: "eq", value: "z9", connector: "AND" },
    ];
    const result = filterListByWhere(testData, where);
    expect(result).toEqual([]);
  });
});

describe("sortListByField", () => {
  const testData = [
    { id: 3, name: "Charlie", age: 35, score: 85.5 },
    { id: 1, name: "Alice", age: 25, score: 92.0 },
    { id: 2, name: "Bob", age: 30, score: 78.3 },
    { id: 4, name: "David", age: 28, score: 95.7 },
  ];

  describe("basic functionality", () => {
    it("should return data unchanged when sort is undefined", () => {
      const result = sortListByField(testData, undefined);
      expect(result).toEqual(testData);
    });

    it("should sort numbers in ascending order", () => {
      const result = sortListByField(testData, {
        field: "age",
        direction: "asc",
      });
      expect(result.map((item) => item.age)).toEqual([25, 28, 30, 35]);
    });

    it("should sort numbers in descending order", () => {
      const result = sortListByField(testData, {
        field: "age",
        direction: "desc",
      });
      expect(result.map((item) => item.age)).toEqual([35, 30, 28, 25]);
    });

    it("should sort strings in ascending order", () => {
      const result = sortListByField(testData, {
        field: "name",
        direction: "asc",
      });
      expect(result.map((item) => item.name)).toEqual([
        "Alice",
        "Bob",
        "Charlie",
        "David",
      ]);
    });

    it("should sort strings in descending order", () => {
      const result = sortListByField(testData, {
        field: "name",
        direction: "desc",
      });
      expect(result.map((item) => item.name)).toEqual([
        "David",
        "Charlie",
        "Bob",
        "Alice",
      ]);
    });

    it("should sort floating point numbers correctly", () => {
      const result = sortListByField(testData, {
        field: "score",
        direction: "asc",
      });
      expect(result.map((item) => item.score)).toEqual([
        78.3, 85.5, 92.0, 95.7,
      ]);
    });
  });

  describe("edge cases", () => {
    it("should handle empty array", () => {
      const result = sortListByField([], { field: "name", direction: "asc" });
      expect(result).toEqual([]);
    });

    it("should handle single item array", () => {
      const singleItem = [{ id: 1, name: "Alice" }];
      const result = sortListByField(singleItem, {
        field: "name",
        direction: "asc",
      });
      expect(result).toEqual(singleItem);
    });

    it("should handle mixed data types gracefully", () => {
      const mixedData = [
        { id: 1, value: "string" },
        { id: 2, value: 42 },
        { id: 3, value: "another" },
      ];
      const result = sortListByField(mixedData, {
        field: "value",
        direction: "asc",
      });
      // Should not throw error, but behavior may be unpredictable
      expect(result).toHaveLength(3);
    });

    it("should handle undefined field values", () => {
      const dataWithUndefined = [
        { id: 1, name: "Alice", age: 25 },
        { id: 2, name: "Bob", age: undefined },
        { id: 3, name: "Charlie", age: 30 },
      ];
      const result = sortListByField(dataWithUndefined, {
        field: "age",
        direction: "asc",
      });
      expect(result).toHaveLength(3);
    });
  });
});

describe("paginateList", () => {
  const testData = [
    { id: 1, name: "Alice" },
    { id: 2, name: "Bob" },
    { id: 3, name: "Charlie" },
    { id: 4, name: "David" },
    { id: 5, name: "Eve" },
    { id: 6, name: "Frank" },
    { id: 7, name: "Grace" },
    { id: 8, name: "Henry" },
  ];

  describe("basic functionality", () => {
    it("should return all data when limit and offset are undefined", () => {
      const result = paginateList(testData, undefined, undefined);
      expect(result).toEqual(testData);
    });

    it("should return all data when limit and offset are undefined (explicit)", () => {
      const result = paginateList(testData, undefined, undefined);
      expect(result).toEqual(testData);
    });

    it("should apply only limit when offset is undefined", () => {
      const result = paginateList(testData, 3, undefined);
      expect(result).toEqual([
        { id: 1, name: "Alice" },
        { id: 2, name: "Bob" },
        { id: 3, name: "Charlie" },
      ]);
    });

    it("should apply only offset when limit is undefined", () => {
      const result = paginateList(testData, undefined, 3);
      expect(result).toEqual([
        { id: 4, name: "David" },
        { id: 5, name: "Eve" },
        { id: 6, name: "Frank" },
        { id: 7, name: "Grace" },
        { id: 8, name: "Henry" },
      ]);
    });

    it("should apply both limit and offset", () => {
      const result = paginateList(testData, 3, 2);
      expect(result).toEqual([
        { id: 3, name: "Charlie" },
        { id: 4, name: "David" },
        { id: 5, name: "Eve" },
      ]);
    });
  });

  describe("edge cases", () => {
    it("should handle empty array", () => {
      const result = paginateList([], 5, 0);
      expect(result).toEqual([]);
    });

    it("should handle offset beyond array length", () => {
      const result = paginateList(testData, 5, 10);
      expect(result).toEqual([]);
    });

    it("should handle limit larger than remaining items", () => {
      const result = paginateList(testData, 10, 5);
      expect(result).toEqual([
        { id: 6, name: "Frank" },
        { id: 7, name: "Grace" },
        { id: 8, name: "Henry" },
      ]);
    });

    it("should handle zero limit", () => {
      const result = paginateList(testData, 0, 2);
      expect(result).toEqual([]);
    });

    it("should handle zero offset", () => {
      const result = paginateList(testData, 3, 0);
      expect(result).toEqual([
        { id: 1, name: "Alice" },
        { id: 2, name: "Bob" },
        { id: 3, name: "Charlie" },
      ]);
    });

    it("should handle negative offset (treats as 0)", () => {
      const result = paginateList(testData, 3, -1);
      expect(result).toEqual([
        { id: 1, name: "Alice" },
        { id: 2, name: "Bob" },
        { id: 3, name: "Charlie" },
      ]);
    });

    it("should handle exact boundary conditions", () => {
      const result = paginateList(testData, 4, 4);
      expect(result).toEqual([
        { id: 5, name: "Eve" },
        { id: 6, name: "Frank" },
        { id: 7, name: "Grace" },
        { id: 8, name: "Henry" },
      ]);
    });
  });

  describe("boundary testing", () => {
    it("should handle offset at array boundary", () => {
      const result = paginateList(testData, 5, 8);
      expect(result).toEqual([]);
    });

    it("should handle limit that matches remaining items exactly", () => {
      const result = paginateList(testData, 3, 5);
      expect(result).toEqual([
        { id: 6, name: "Frank" },
        { id: 7, name: "Grace" },
        { id: 8, name: "Henry" },
      ]);
    });

    it("should handle single item result", () => {
      const result = paginateList(testData, 1, 4);
      expect(result).toEqual([{ id: 5, name: "Eve" }]);
    });
  });
});

describe("isWhereBySingleField", () => {
  it("should return true if the where condition is an id", () => {
    const where: CleanedWhere[] = [
      { field: "id", operator: "eq", value: "1", connector: "AND" },
    ];
    expect(isWhereBySingleField("id", where)).toBe(true);
  });

  it("should return false if the where condition is not an id", () => {
    const where: CleanedWhere[] = [
      { field: "name", operator: "eq", value: "Alice", connector: "AND" },
    ];
    expect(isWhereBySingleField("id", where)).toBe(false);
  });

  it("should return false if the where condition has more than one condition", () => {
    const where: CleanedWhere[] = [
      { field: "name", operator: "eq", value: "Alice", connector: "AND" },
      { field: "id", operator: "eq", value: "1", connector: "AND" },
    ];
    expect(isWhereBySingleField("id", where)).toBe(false);
  });

  it("should return false if the where condition has no condition", () => {
    const where: CleanedWhere[] = [];
    expect(isWhereBySingleField("id", where)).toBe(false);
  });

  it("should return false if the where condition on ID is not eq", () => {
    const where: CleanedWhere[] = [
      { field: "id", operator: "gt", value: "1", connector: "AND" },
    ];
    expect(isWhereBySingleField("id", where)).toBe(false);
  });
});
