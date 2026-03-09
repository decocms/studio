/**
 * MONITORING_AGENT_LAST_USED Tool
 *
 * Returns the last time each agent (Virtual MCP) was used,
 * based on monitoring logs. Useful for identifying stale agents.
 */

import { requireOrganization } from "@/core/mesh-context";
import { defineTool } from "../../core/define-tool";
import { z } from "zod";

export const MONITORING_AGENT_LAST_USED = defineTool({
  name: "MONITORING_AGENT_LAST_USED",
  description:
    "Get the last usage timestamp for each agent (Virtual MCP), derived from monitoring logs",
  annotations: {
    title: "Get Agent Last Used",
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  inputSchema: z.object({
    virtualMcpIds: z
      .array(z.string())
      .max(500)
      .describe("List of Virtual MCP (Agent) IDs to check"),
  }),
  outputSchema: z.object({
    lastUsed: z
      .record(z.string(), z.string())
      .describe(
        "Map of virtualMcpId to last used ISO 8601 timestamp. Missing keys mean the agent was never used.",
      ),
  }),
  handler: async (input, ctx) => {
    const org = requireOrganization(ctx);

    const lastUsed = await ctx.storage.monitoring.getLastUsedByVirtualMcpIds(
      org.id,
      input.virtualMcpIds,
    );

    return { lastUsed };
  },
});
