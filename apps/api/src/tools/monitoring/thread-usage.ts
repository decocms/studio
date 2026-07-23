/**
 * MONITORING_THREAD_USAGE Tool
 *
 * Aggregate LLM token usage + USD cost per thread, derived from llm_call
 * monitoring logs grouped by `properties.thread_id`. Used to decorate the
 * Threads monitoring tab with Tokens / Cost columns.
 */

import { requireOrganization } from "@/core/studio-context";
import { flushMonitoringData } from "@/observability";
import { defineTool } from "../../core/define-tool";
import { z } from "zod";

export const MONITORING_THREAD_USAGE = defineTool({
  name: "MONITORING_THREAD_USAGE",
  description:
    "Aggregate LLM token usage and USD cost per thread for the given thread IDs.",
  annotations: {
    title: "Get Thread Usage",
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  inputSchema: z.object({
    threadIds: z
      .array(z.string())
      .min(1)
      .max(500)
      .describe("Thread IDs to aggregate usage for (max 500)"),
    connectionId: z
      .string()
      .optional()
      .describe("LLM connection ID (defaults to 'decopilot')"),
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
  }),
  outputSchema: z.object({
    items: z.array(
      z.object({
        threadId: z.string(),
        calls: z.number(),
        inputTokens: z.number(),
        outputTokens: z.number(),
        totalTokens: z.number(),
        costUsd: z.number(),
      }),
    ),
  }),
  handler: async (input, ctx) => {
    const org = requireOrganization(ctx);
    await ctx.access.check();
    await flushMonitoringData();

    const items = await ctx.storage.monitoring.queryThreadUsage({
      organizationId: org.id,
      connectionId: input.connectionId ?? "decopilot",
      threadIds: input.threadIds,
      startDate: input.startDate ? new Date(input.startDate) : undefined,
      endDate: input.endDate ? new Date(input.endDate) : undefined,
    });

    return { items };
  },
});
