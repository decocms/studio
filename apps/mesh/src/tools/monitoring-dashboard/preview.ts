/**
 * MONITORING_WIDGET_PREVIEW Tool
 *
 * Preview a widget aggregation without saving it.
 * Used by the dashboard editor to test queries before saving.
 */

import { requireOrganization } from "@/core/mesh-context";
import { defineTool } from "../../core/define-tool";
import { z } from "zod";
import type { AggregationFunction } from "@/storage/types";

const WidgetConfigSchema = z.object({
  type: z.enum(["metric", "timeseries", "table"]),
  source: z.object({
    path: z.string().describe("JSONPath to extract value from"),
    from: z.enum(["input", "output"]).describe("Extract from input or output"),
  }),
  aggregation: z.object({
    fn: z
      .enum(["sum", "avg", "min", "max", "count", "count_all", "last"])
      .describe("Aggregation function"),
    groupBy: z.string().optional().describe("JSONPath for grouping (table)"),
    interval: z
      .string()
      .optional()
      .describe("Time interval for timeseries (15m, 1h, 1d)"),
  }),
  filter: z
    .object({
      connectionIds: z.array(z.string()).optional(),
      toolNames: z.array(z.string()).optional(),
    })
    .optional(),
});

export const MONITORING_WIDGET_PREVIEW = defineTool({
  name: "MONITORING_WIDGET_PREVIEW",
  description:
    "Preview a widget aggregation without saving. Used to test queries in the dashboard editor.",
  annotations: {
    title: "Preview Monitoring Widget",
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  inputSchema: z.object({
    widget: WidgetConfigSchema.describe("Widget configuration to preview"),
    timeRange: z
      .object({
        startDate: z
          .string()
          .datetime()
          .describe("Start of time range (ISO 8601)"),
        endDate: z.string().datetime().describe("End of time range (ISO 8601)"),
      })
      .optional()
      .describe("Time range for the query (defaults to last 24 hours)"),
    propertyFilters: z
      .object({
        properties: z
          .record(z.string(), z.string())
          .optional()
          .describe("Exact match: property key equals value"),
        propertyKeys: z
          .array(z.string())
          .optional()
          .describe("Exists: filter logs that have these property keys"),
        propertyPatterns: z
          .record(z.string(), z.string())
          .optional()
          .describe("Pattern match: property value matches pattern (SQL LIKE)"),
        propertyInValues: z
          .record(z.string(), z.string())
          .optional()
          .describe("In match: exact match within comma-separated values"),
      })
      .optional()
      .describe("Property filters to apply"),
  }),
  outputSchema: z.object({
    value: z.number().nullable().optional().describe("Aggregated value"),
    groups: z
      .array(z.object({ key: z.string(), value: z.number() }))
      .optional()
      .describe("Grouped results for table widgets"),
    timeseries: z
      .array(z.object({ timestamp: z.string(), value: z.number() }))
      .optional()
      .describe("Timeseries data points"),
    matchedRecords: z.number().describe("Number of records that matched"),
    timeRange: z
      .object({
        startDate: z.string(),
        endDate: z.string(),
      })
      .describe("Time range used for the query"),
  }),
  handler: async (input, ctx) => {
    const org = requireOrganization(ctx);
    const { widget, timeRange } = input;

    // Determine time range
    const now = new Date();
    const startDate = timeRange?.startDate
      ? new Date(timeRange.startDate)
      : new Date(now.getTime() - 24 * 60 * 60 * 1000);
    const endDate = timeRange?.endDate ? new Date(timeRange.endDate) : now;

    // Build filters
    const filters = {
      connectionIds: widget.filter?.connectionIds,
      toolNames: widget.filter?.toolNames,
      startDate,
      endDate,
      propertyFilters: input.propertyFilters,
    };

    try {
      // First, get count of matched records
      const matchedRecords = await ctx.storage.monitoring.countMatched({
        organizationId: org.id,
        path: widget.source.path,
        from: widget.source.from,
        filters,
      });

      // Then run the aggregation
      const result = await ctx.storage.monitoring.aggregate({
        organizationId: org.id,
        path: widget.source.path,
        from: widget.source.from,
        aggregation: widget.aggregation.fn as AggregationFunction,
        groupBy: widget.aggregation.groupBy,
        interval: widget.aggregation.interval,
        filters,
      });

      return {
        value: result.value,
        groups: result.groups,
        timeseries: result.timeseries,
        matchedRecords,
        timeRange: {
          startDate: startDate.toISOString(),
          endDate: endDate.toISOString(),
        },
      };
    } catch (error) {
      console.error("Widget preview aggregation failed:", error);
      return {
        value: null,
        matchedRecords: 0,
        timeRange: {
          startDate: startDate.toISOString(),
          endDate: endDate.toISOString(),
        },
      };
    }
  },
});
