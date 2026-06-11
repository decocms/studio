import { describe, expect, test } from "bun:test";
import { MANAGEMENT_TOOLS } from "./registry-metadata";

describe("decopilot-mcp gateway tools removed", () => {
  test("the four *_MCP names are gone from the tool registry", () => {
    // ALL_TOOL_NAMES is not exported; MANAGEMENT_TOOLS is the public metadata
    // array whose `name` fields are the `(typeof ALL_TOOL_NAMES)[number]` union.
    const names = MANAGEMENT_TOOLS.map((t) => t.name as string);
    expect(names).not.toContain("WEB_SEARCH_MCP");
    expect(names).not.toContain("UPDATE_INTERESTS_MCP");
    expect(names).not.toContain("TAKE_SCREENSHOT_MCP");
    expect(names).not.toContain("GENERATE_IMAGE_MCP");
  });

  test("the decopilot-mcp module no longer resolves", async () => {
    await expect(
      // @ts-expect-error — the decopilot-mcp module is intentionally deleted; tsc
      // would otherwise flag the missing module. The runtime rejection IS the assertion.
      import("./decopilot-mcp"),
    ).rejects.toThrow();
  });
});
