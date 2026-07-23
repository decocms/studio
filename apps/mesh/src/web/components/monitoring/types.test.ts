import { describe, expect, test } from "bun:test";
import { deserializePropertyFilters } from "./types.tsx";

describe("deserializePropertyFilters", () => {
  test("parses a known operator", () => {
    expect(deserializePropertyFilters("status:contains:error")).toEqual([
      { key: "status", operator: "contains", value: "error" },
    ]);
  });

  test("falls back to eq for an unrecognized/stale operator", () => {
    expect(deserializePropertyFilters("status:regex:error")).toEqual([
      { key: "status", operator: "eq", value: "error" },
    ]);
  });

  test("falls back to eq when the operator segment is missing", () => {
    expect(deserializePropertyFilters("status")).toEqual([
      { key: "status", operator: "eq", value: "" },
    ]);
  });
});
