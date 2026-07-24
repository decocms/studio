import { describe, expect, it } from "bun:test";
import type { WhereExpression } from "@decocms/bindings/collections";
import { extractThreadIdFromWhere } from "./list-messages";

describe("extractThreadIdFromWhere", () => {
  it("returns null when there is no where clause", () => {
    expect(extractThreadIdFromWhere(undefined)).toBeNull();
  });

  it("extracts thread_id from a direct eq comparison", () => {
    const where: WhereExpression = {
      field: ["thread_id"],
      operator: "eq",
      value: "thread-A",
    };
    expect(extractThreadIdFromWhere(where)).toBe("thread-A");
  });

  it("extracts thread_id nested under an 'and' group", () => {
    const where: WhereExpression = {
      operator: "and",
      conditions: [{ field: ["thread_id"], operator: "eq", value: "thread-A" }],
    };
    expect(extractThreadIdFromWhere(where)).toBe("thread-A");
  });

  it("extracts thread_id nested under an 'or' group", () => {
    const where: WhereExpression = {
      operator: "or",
      conditions: [{ field: ["thread_id"], operator: "eq", value: "thread-A" }],
    };
    expect(extractThreadIdFromWhere(where)).toBe("thread-A");
  });

  it("does NOT extract thread_id nested under a 'not' group (exclusion, not scoping)", () => {
    const where: WhereExpression = {
      operator: "not",
      conditions: [{ field: ["thread_id"], operator: "eq", value: "thread-A" }],
    };
    // Excluding thread-A must never resolve to scoping the query to thread-A.
    expect(extractThreadIdFromWhere(where)).toBeNull();
  });
});
