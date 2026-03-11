/**
 * MONITORING_STATS Tool
 *
 * Get aggregated statistics for monitoring logs.
 * Supports both summary stats (backward-compatible) and timeseries queries.
 */

import { requireOrganization } from "@/core/mesh-context";
import { flushMonitoringData } from "@/observability";
import { defineTool } from "../../core/define-tool";
import { z } from "zod";

export const MONITORING_STATS = defineTool({
  name: "MONITORING_STATS",
  description: "Get aggregated statistics for tool call monitoring",
  annotations: {
    title: "Get Monitoring Stats",
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
    interval: z
      .enum(["1m", "1h", "1d"])
      .optional()
      .describe(
        "Bucket interval for timeseries data. When provided, returns timeseries array.",
      ),
    connectionIds: z
      .array(z.string())
      .max(100)
      .optional()
      .describe("Filter by specific connection IDs (max 100)"),
    excludeConnectionIds: z
      .array(z.string())
      .max(100)
      .optional()
      .describe("Exclude specific connection IDs (max 100)"),
    toolNames: z
      .array(z.string())
      .max(100)
      .optional()
      .describe("Filter by specific tool names (max 100)"),
    status: z
      .enum(["success", "error"])
      .optional()
      .describe("Filter metrics by execution status"),
    topN: z
      .number()
      .int()
      .min(1)
      .max(20)
      .optional()
      .describe(
        "When provided with interval, also return top tools and their timeseries",
      ),
  }),
  outputSchema: z.object({
    totalCalls: z.number().describe("Total number of tool calls"),
    errorRate: z
      .number()
      .optional()
      .describe("Error rate as a decimal (0 to 1)"),
    avgDurationMs: z.number().describe("Average call duration in milliseconds"),
    errorRatePercent: z
      .string()
      .optional()
      .describe("Error rate as a percentage string"),
    totalErrors: z.number().optional().describe("Total number of errors"),
    p50DurationMs: z
      .number()
      .optional()
      .describe("50th percentile duration in milliseconds"),
    p95DurationMs: z
      .number()
      .optional()
      .describe("95th percentile duration in milliseconds"),
    connectionBreakdown: z
      .array(
        z.object({
          connectionId: z.string(),
          calls: z.number(),
          errors: z.number(),
          errorRate: z.number(),
          avgDurationMs: z.number(),
        }),
      )
      .optional()
      .describe("Per-connection metric breakdown"),
    topTools: z
      .array(
        z.object({
          toolName: z.string(),
          connectionId: z.string().nullable(),
          calls: z.number(),
        }),
      )
      .optional()
      .describe("Top tools ranked by calls"),
    topToolsTimeseries: z
      .array(
        z.object({
          timestamp: z.string(),
          toolName: z.string(),
          calls: z.number(),
          errors: z.number(),
          avg: z.number(),
          p95: z.number(),
        }),
      )
      .optional()
      .describe("Per-tool metric timeseries for the top tools"),
    timeseries: z
      .array(
        z.object({
          timestamp: z.string(),
          calls: z.number(),
          errors: z.number(),
          errorRate: z.number(),
          avg: z.number(),
          p50: z.number(),
          p95: z.number(),
        }),
      )
      .optional()
      .describe("Timeseries data points bucketed by interval"),
  }),
  handler: async (input, ctx) => {
    const org = requireOrganization(ctx);
    await ctx.access.check();
    await flushMonitoringData();

    if (input.interval) {
      const stats = await ctx.storage.monitoring.queryMetricTimeseries({
        organizationId: org.id,
        interval: input.interval,
        startDate: input.startDate ? new Date(input.startDate) : undefined,
        endDate: input.endDate ? new Date(input.endDate) : undefined,
        filters: {
          connectionIds: input.connectionIds,
          excludeConnectionIds: input.excludeConnectionIds,
          toolNames: input.toolNames,
          status: input.status,
        },
      });

      if (!input.topN) {
        return stats;
      }

      const topTools =
        await ctx.storage.monitoring.queryMetricTopToolsTimeseries({
          organizationId: org.id,
          interval: input.interval,
          startDate: input.startDate ? new Date(input.startDate) : undefined,
          endDate: input.endDate ? new Date(input.endDate) : undefined,
          topN: input.topN,
          filters: {
            connectionIds: input.connectionIds,
            excludeConnectionIds: input.excludeConnectionIds,
            toolNames: input.toolNames,
            status: input.status,
          },
        });

      return {
        ...stats,
        topTools: topTools.topTools,
        topToolsTimeseries: topTools.timeseries,
      };
    }

    // Backward-compatible path
    const stats = await ctx.storage.monitoring.getStats({
      organizationId: org.id,
      startDate: input.startDate ? new Date(input.startDate) : undefined,
      endDate: input.endDate ? new Date(input.endDate) : undefined,
    });
    return { ...stats, errorRatePercent: (stats.errorRate * 100).toFixed(2) };
  },
});
