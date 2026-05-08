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
    .optional()
    .describe("Specific tool names to enable"),
  connections: z
    .array(z.string())
    .optional()
    .describe(
      "Connection IDs from <available-connections> — enables all tools in those connections",
    ),
});

/**
 * Create the enable_tools built-in tool.
 *
 * @param enabledTools - Shared set that tracks which tools have been enabled
 * @param availableToolNames - Set of all tool names from the passthrough client
 * @param connectionToolsMap - Map of connection ID → safe tool names in that connection
 * @param options - Optional config for plan-mode gating
 */
export function createEnableToolsTool(
  enabledTools: Set<string>,
  availableToolNames: Set<string>,
  connectionToolsMap: Map<string, string[]>,
  options?: {
    isPlanMode?: boolean;
    toolAnnotations?: Map<string, { readOnlyHint?: boolean }>;
  },
) {
  return tool({
    description:
      "Enable tools from the available tools catalog so they can be called in subsequent steps. " +
      "Call this before using any tool listed in <available-connections>.\n\n" +
      "Usage notes:\n" +
      "- Pass connection IDs from <available-connections> to enable all tools in a connection at once.\n" +
      "- Pass specific tool names to enable individual tools.\n" +
      "- Built-in tools (user_ask, subtask, agent_search, read_tool_output) are always available and do not need enabling.",
    inputSchema: enableToolsInputSchema,
    execute: async ({ tools = [], connections = [] }) => {
      const enabled: string[] = [];
      const notFound: string[] = [];
      const blocked: string[] = [];

      // Expand connection IDs to their tool names
      const toolsToEnable = [...tools];
      for (const connId of connections) {
        const connTools = connectionToolsMap.get(connId);
        if (!connTools || connTools.length === 0) {
          notFound.push(connId);
          continue;
        }
        toolsToEnable.push(...connTools);
      }

      for (const name of toolsToEnable) {
        if (!availableToolNames.has(name)) {
          notFound.push(name);
          continue;
        }

        // In plan mode, block non-read-only tools
        if (options?.isPlanMode) {
          const annotations = options.toolAnnotations?.get(name);
          if (annotations?.readOnlyHint !== true) {
            blocked.push(name);
            continue;
          }
        }

        enabledTools.add(name);
        enabled.push(name);
      }

      return {
        enabled,
        ...(notFound.length > 0 && { not_found: notFound }),
        ...(blocked.length > 0 && {
          blocked,
          blocked_reason:
            "These tools cannot be enabled in plan mode — they have side effects.",
        }),
      };
    },
  });
}
