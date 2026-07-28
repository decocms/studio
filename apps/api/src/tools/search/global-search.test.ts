import { describe, it, expect } from "bun:test";
import { GLOBAL_SEARCH } from "./global-search";

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
