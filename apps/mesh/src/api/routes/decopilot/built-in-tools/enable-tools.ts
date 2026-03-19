/**
 * Enable Tools
 *
 * Built-in tool that allows the model to activate tools from the available catalog.
 * Tools enabled in step N become callable in step N+1 via the prepareStep callback.
 */

import { tool } from "ai";
import { z } from "zod";
import type { ToolApprovalLevel } from "../helpers";

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
 * @param options - Optional config for plan-mode gating
 */
export function createEnableToolsTool(
  enabledTools: Set<string>,
  availableToolNames: Set<string>,
  options?: {
    toolApprovalLevel?: ToolApprovalLevel;
    toolAnnotations?: Map<string, { readOnlyHint?: boolean }>;
  },
) {
  return tool({
    description:
      "Enable tools from the available tools catalog so they can be called in subsequent steps. " +
      "Call this before using any tool listed in <available-connections>.\n\n" +
      "Usage notes:\n" +
      "- Batch related tools in a single call to minimize round-trips.\n" +
      "- Enable only the tools you need for your next step — you can always enable more later.\n" +
      "- Built-in tools (user_ask, subtask, agent_search, read_tool_output) are always available and do not need enabling.",
    inputSchema: enableToolsInputSchema,
    execute: async ({ tools }) => {
      const enabled: string[] = [];
      const notFound: string[] = [];
      const blocked: string[] = [];

      for (const name of tools) {
        if (!availableToolNames.has(name)) {
          notFound.push(name);
          continue;
        }

        // In plan mode, block non-read-only tools
        if (options?.toolApprovalLevel === "plan") {
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
