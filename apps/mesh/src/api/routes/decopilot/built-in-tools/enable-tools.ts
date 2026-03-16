/**
 * Enable Tools
 *
 * Built-in tool that allows the model to activate tools from the available catalog.
 * Tools enabled in step N become callable in step N+1 via the prepareStep callback.
 */

import { tool } from "ai";
import { z } from "zod";

const enableToolsInputSchema = z.object({
  tools: z
    .array(z.string())
    .describe("List of tool names to enable from the available tools catalog"),
});

/**
 * Create the enable_tools built-in tool.
 *
 * @param enabledTools - Shared set that tracks which tools have been enabled
 * @param availableToolNames - Set of all tool names from the passthrough client
 */
export function createEnableToolsTool(
  enabledTools: Set<string>,
  availableToolNames: Set<string>,
) {
  return tool({
    description:
      "Enable tools from the available tools catalog so they can be called in subsequent steps. Call this before using any tool listed in <available-tools>.",
    inputSchema: enableToolsInputSchema,
    execute: async ({ tools }) => {
      const enabled: string[] = [];
      const notFound: string[] = [];

      for (const name of tools) {
        if (availableToolNames.has(name)) {
          enabledTools.add(name);
          enabled.push(name);
        } else {
          notFound.push(name);
        }
      }

      return {
        enabled,
        ...(notFound.length > 0 && { not_found: notFound }),
      };
    },
  });
}
