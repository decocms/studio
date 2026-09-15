import { describe, expect, test } from "bun:test";
import { normalizeAppToolName } from "./app-tool-name";

describe("normalizeAppToolName", () => {
  test("preserves percent characters from an already-decoded route param", () => {
    expect(normalizeAppToolName("discount%rate")).toBe("discount%rate");
    expect(normalizeAppToolName("tool%2Fname")).toBe("tool%2Fname");
  });

  test("still removes coding-agent MCP server prefixes", () => {
    expect(normalizeAppToolName("mcp__studio__get_orders")).toBe("get_orders");
  });
});
