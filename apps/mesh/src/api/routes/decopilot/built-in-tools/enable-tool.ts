/**
 * Enable Tool
 *
 * Built-in tool that activates tools from the current agent's catalog.
 * Tools enabled in step N become callable in step N+1 via the prepareStep
 * callback in stream-core.
 */

import { tool } from "ai";
import { z } from "zod";

export const EnableToolInputSchema = z.object({
  tools: z
    .array(z.string())
    .min(1)
    .describe("Tool ids to enable. Discover ids via search_tool."),
});

/**
 * Create the enable_tool built-in.
 *
 * @param enabledTools - Shared set that tracks which tools have been enabled
 * @param availableToolNames - Set of all tool names exposed by the current
 *                             Virtual MCP's passthrough client
 * @param options - Optional config for plan-mode gating
 */
export function createEnableToolTool(
  enabledTools: Set<string>,
  availableToolNames: Set<string>,
  options?: {
    isPlanMode?: boolean;
    toolAnnotations?: Map<string, { readOnlyHint?: boolean }>;
  },
) {
  return tool({
    description:
      "Enable tools from the current agent's catalog so they can be called " +
      "in subsequent steps. Discover tool ids with search_tool first.\n\n" +
      "Usage notes:\n" +
      "- Pass specific tool ids to enable individual tools.\n" +
      "- Built-in tools (user_ask, subtask, search_tool, read_tool_output, read_prompt) are always available and do not need enabling.",
    inputSchema: EnableToolInputSchema,
    execute: async ({ tools }) => {
      const enabled: string[] = [];
      const notFound: string[] = [];
      const blocked: string[] = [];

      for (const name of tools) {
        if (!availableToolNames.has(name)) {
          notFound.push(name);
          continue;
        }

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
