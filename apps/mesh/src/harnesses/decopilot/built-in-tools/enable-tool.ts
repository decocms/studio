/**
 * Enable Tool
 *
 * Activates tools from the current agent's catalog. Tools enabled in step N
 * become callable in step N+1 via the prepareStep callback in dispatch-run.
 */

import { tool } from "ai";
import { z } from "zod";

export const EnableToolInputSchema = z.object({
  tools: z
    .array(z.string())
    .min(1)
    .describe(
      "Tool ids to enable, taken verbatim from <available-connections>.",
    ),
});

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
      "in subsequent steps. Pass tool names exactly as listed in " +
      "<available-connections>.\n\n" +
      "Usage notes:\n" +
      "- Built-in tools (user_ask, subtask, read_tool_output, read_prompt, " +
      "read_resource, sandbox) are always available and do not need enabling.",
    inputSchema: EnableToolInputSchema,
    execute: async ({ tools }) => {
      const enabled: string[] = [];
      const notFound: string[] = [];
      const blocked: string[] = [];

      for (const requested of tools) {
        if (!availableToolNames.has(requested)) {
          notFound.push(requested);
          continue;
        }

        if (options?.isPlanMode) {
          const annotations = options.toolAnnotations?.get(requested);
          if (annotations?.readOnlyHint !== true) {
            blocked.push(requested);
            continue;
          }
        }

        enabledTools.add(requested);
        enabled.push(requested);
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
