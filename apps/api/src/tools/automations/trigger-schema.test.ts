import { describe, expect, test } from "bun:test";
import { ToolsAllowlistSchema } from "./trigger-schema";

describe("ToolsAllowlistSchema", () => {
  test("accepts a small tools allowlist", () => {
    expect(ToolsAllowlistSchema.safeParse(["FOO", "BAR"]).success).toBe(true);
  });

  test("rejects more than 200 entries", () => {
    const tools = Array.from({ length: 201 }, (_, i) => `TOOL_${i}`);
    expect(ToolsAllowlistSchema.safeParse(tools).success).toBe(false);
  });

  test("rejects a tool name over the string length cap", () => {
    expect(ToolsAllowlistSchema.safeParse(["a".repeat(201)]).success).toBe(
      false,
    );
  });
});
