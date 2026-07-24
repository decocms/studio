import { existsSync } from "node:fs";
import { describe, expect, test } from "bun:test";
import { MANAGEMENT_TOOLS } from "@decocms/shared/tools/registry-metadata";

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

  test("the decopilot-mcp directory no longer exists", () => {
    // The gateway-copy tools were removed; the directory must stay gone. A
    // filesystem check asserts removal without a static import of the deleted
    // path (which dead-import analysis would otherwise flag).
    const dir = new URL("./decopilot-mcp", import.meta.url).pathname;
    expect(existsSync(dir)).toBe(false);
  });
});
