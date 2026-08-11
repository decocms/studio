/**
 * MONITORING_HEATMAP Tool
 *
 * Tool-call volume per (agent, tool) pair, for the Monitoring heatmap card.
 */

import { requireOrganization } from "@/core/studio-context";
import { flushMonitoringData } from "@/observability";
import { defineTool } from "../../core/define-tool";
import { z } from "zod";

export const MONITORING_HEATMAP = defineTool({
  name: "MONITORING_HEATMAP",
  description:
    "Get tool-call volume broken down by agent and tool name, for spotting heavily-used tools per agent.",
  annotations: {
    title: "Get Tool-Call Heatmap",
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  inputSchema: z.object({
    startDate: z
      .string()
      .datetime()
      .optional()
      .describe("Filter by start date (ISO 8601 datetime string)"),
    endDate: z
      .string()
      .datetime()
      .optional()
      .describe("Filter by end date (ISO 8601 datetime string)"),
    virtualMcpIds: z
      .array(z.string())
      .max(100)
      .optional()
      .describe("Filter by specific agent (Virtual MCP) IDs"),
    excludeConnectionIds: z
      .array(z.string())
      .max(100)
      .optional()
      .describe("Exclude tool calls from these connection IDs"),
    limit: z
      .number()
      .int()
      .min(1)
      .max(1000)
      .optional()
      .describe("Max number of (agent, tool) cells to return"),
  }),
  outputSchema: z.object({
    cells: z.array(
      z.object({
        virtualMcpId: z.string().nullable(),
        toolName: z.string(),
        calls: z.number(),
        errors: z.number(),
        outputSize: z
          .number()
          .describe(
            "Sum of tool-output character length — a proxy for context weight, not LLM token count",
          ),
      }),
    ),
  }),
  handler: async (input, ctx) => {
    const org = requireOrganization(ctx);
    await ctx.access.check();
    await flushMonitoringData();

    return ctx.storage.monitoring.queryToolCallHeatmap({
      organizationId: org.id,
      startDate: input.startDate ? new Date(input.startDate) : undefined,
      endDate: input.endDate ? new Date(input.endDate) : undefined,
      filters: {
        virtualMcpIds: input.virtualMcpIds,
        excludeConnectionIds: input.excludeConnectionIds,
      },
      limit: input.limit,
    });
  },
});
