/**
 * Registry Tests
 *
 * Ensures registry.ts stays in sync with index.ts
 */

import { describe, expect, it } from "bun:test";
import { CORE_TOOLS } from "./index";
import { MANAGEMENT_TOOLS } from "@decocms/shared/tools/registry-metadata";

describe("Tool Registry Sync", () => {
  it("should have MANAGEMENT_TOOLS entries for all tools in CORE_TOOLS", () => {
    const coreToolNames: string[] = CORE_TOOLS.map((t) => t.name);
    const registryToolNames = MANAGEMENT_TOOLS.map((t) => t.name);

    // Check MANAGEMENT_TOOLS → CORE_TOOLS (registry entries must exist in CORE_TOOLS)
    for (const toolName of registryToolNames) {
      expect(
        coreToolNames,
        `Extra "${toolName}" in MANAGEMENT_TOOLS (registry.ts) not in CORE_TOOLS (index.ts). Remove it!`,
      ).toContain(toolName as string);
    }
  });
});
