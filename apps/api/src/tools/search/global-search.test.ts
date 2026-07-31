import { describe, it, expect } from "bun:test";
import {
  GLOBAL_SEARCH,
  normalizeSearchQuery,
  includesSearchType,
} from "./global-search";

describe("GLOBAL_SEARCH input schema", () => {
  it("rejects a query longer than 256 characters", () => {
    const result = GLOBAL_SEARCH.inputSchema.safeParse({
      query: "a".repeat(257),
    });
    expect(result.success).toBe(false);
  });

  it("accepts a query at the 256 character boundary", () => {
    const result = GLOBAL_SEARCH.inputSchema.safeParse({
      query: "a".repeat(256),
    });
    expect(result.success).toBe(true);
  });
});

describe("normalizeSearchQuery", () => {
  it("treats an empty string as no query", () => {
    expect(normalizeSearchQuery("")).toBeUndefined();
  });

  it("treats a whitespace-only string as no query", () => {
    expect(normalizeSearchQuery("   \n\t ")).toBeUndefined();
  });

  it("trims surrounding whitespace from a real query", () => {
    expect(normalizeSearchQuery("  foo  ")).toBe("foo");
  });

  it("leaves an already-trimmed query unchanged", () => {
    expect(normalizeSearchQuery("foo bar")).toBe("foo bar");
  });
});

describe("includesSearchType", () => {
  it("includes every type when `types` is omitted", () => {
    expect(includesSearchType(undefined, "thread")).toBe(true);
  });

  it("includes a type present in the filter", () => {
    expect(includesSearchType(["thread"], "thread")).toBe(true);
  });

  it("excludes a type absent from a non-empty filter", () => {
    expect(includesSearchType(["other"], "thread")).toBe(false);
  });

  it("excludes every type when `types` is an empty array", () => {
    expect(includesSearchType([], "thread")).toBe(false);
  });
});
