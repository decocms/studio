import { describe, expect, test } from "bun:test";
import { parseFilters } from "./monitor";

describe("parseFilters", () => {
  test("drops entries whose value isn't a string", () => {
    const raw = JSON.stringify([
      { field: "status_code", op: "equals", value: 404 },
      { field: "path", op: "contains", value: "/checkout" },
    ]);
    expect(parseFilters(raw)).toEqual([
      { field: "path", op: "contains", value: "/checkout" },
    ]);
  });

  test("drops an oversized filter value", () => {
    const raw = JSON.stringify([
      { field: "path", op: "contains", value: "x".repeat(501) },
    ]);
    expect(parseFilters(raw)).toEqual([]);
  });

  test("caps the number of filters", () => {
    const filters = Array.from({ length: 30 }, (_, i) => ({
      field: "path",
      op: "equals",
      value: `v${i}`,
    }));
    expect(parseFilters(JSON.stringify(filters))).toHaveLength(20);
  });
});
