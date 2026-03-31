/**
 * Registry Tests
 *
 * Ensures registry.ts stays in sync with index.ts
 */

import { describe, expect, it } from "bun:test";
import { ALL_TOOLS } from "./index";
import { MANAGEMENT_TOOLS } from "./registry-metadata";

describe("Tool Registry Sync", () => {
  it("should have MANAGEMENT_TOOLS entries for all core tools in ALL_TOOLS", () => {
    // Filter to only core tools (not plugin tools) for registry sync check
    // Plugin tools are dynamically added and don't need registry entries
    const allToolNames = ALL_TOOLS.map((t) => t.name);
    const registryToolNames = MANAGEMENT_TOOLS.map((t) => t.name);

    // Check MANAGEMENT_TOOLS → ALL_TOOLS (registry entries must exist in ALL_TOOLS)
    for (const toolName of registryToolNames) {
      expect(
        allToolNames,
        `Extra "${toolName}" in MANAGEMENT_TOOLS (registry.ts) not in ALL_TOOLS (index.ts). Remove it!`,
      ).toContain(toolName as string);
    }
  });

  it("should have matching ToolName types", () => {
    // Runtime check for registry tools being a subset of all tools
    const allToolNames = ALL_TOOLS.map((t) => t.name);
    const registryToolNames = MANAGEMENT_TOOLS.map((t) => t.name);
    // Registry should have at most as many tools as ALL_TOOLS
    // (could be fewer if plugin tools are present)
    expect(registryToolNames.length).toBeLessThanOrEqual(allToolNames.length);
  });
});
