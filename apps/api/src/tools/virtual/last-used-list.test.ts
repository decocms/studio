import { describe, expect, test } from "bun:test";
import { VIRTUAL_MCP_LAST_USED_LIST } from "./last-used-list";

describe("VIRTUAL_MCP_LAST_USED_LIST input schema", () => {
  test("accepts a reasonably sized ids array", () => {
    const result = VIRTUAL_MCP_LAST_USED_LIST.inputSchema.safeParse({
      ids: ["a", "b"],
    });
    expect(result.success).toBe(true);
  });

  test("rejects an ids array over the bound", () => {
    const result = VIRTUAL_MCP_LAST_USED_LIST.inputSchema.safeParse({
      ids: Array.from({ length: 1001 }, (_, i) => `id_${i}`),
    });
    expect(result.success).toBe(false);
  });
});
