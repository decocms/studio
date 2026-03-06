/**
 * MONITORING_DASHBOARD_QUERY Tool
 *
 * Executes a dashboard's widgets and returns aggregated data.
 */

import { requireOrganization } from "@/core/mesh-context";
import { defineTool } from "../../core/define-tool";
import { z } from "zod";
import { WidgetQueryResultSchema, type WidgetQueryResult } from "./schema";
import type { AggregationFunction, DashboardWidget } from "@/storage/types";
import type { GroupByColumn } from "@/storage/monitoring";

export const MONITORING_DASHBOARD_QUERY = defineTool({
  name: "MONITORING_DASHBOARD_QUERY",
  description:
    "Execute a dashboard's widgets and return aggregated monitoring data",
  annotations: {
    title: "Query Monitoring Dashboard",
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  inputSchema: z.object({
    dashboardId: z.string().describe("Dashboard ID to query"),
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
          .describe(
            "Pattern match: property value matches pattern (SQL LIKE, use % as wildcard)",
          ),
        propertyInValues: z
          .record(z.string(), z.string())
          .optional()
          .describe("In match: exact match within comma-separated values"),
      })
      .optional()
      .describe(
        "Runtime property filters applied to all widgets (merged with dashboard-level filters)",
      ),
  }),
  outputSchema: z.object({
    dashboardId: z.string().describe("Dashboard ID"),
    results: z.array(WidgetQueryResultSchema).describe("Widget query results"),
    timeRange: z
      .object({
        startDate: z.string(),
        endDate: z.string(),
      })
      .describe("Time range used for the query"),
  }),
  handler: async (input, ctx) => {
    const org = requireOrganization(ctx);

    // Get the dashboard
    const dashboard = await ctx.storage.monitoringDashboards.get(
      input.dashboardId,
    );
    if (!dashboard || dashboard.organizationId !== org.id) {
      throw new Error(`Dashboard ${input.dashboardId} not found`);
    }

    // Determine time range
    const now = new Date();
    const startDate = input.timeRange?.startDate
      ? new Date(input.timeRange.startDate)
      : new Date(now.getTime() - 24 * 60 * 60 * 1000); // Default: last 24h
    const endDate = input.timeRange?.endDate
      ? new Date(input.timeRange.endDate)
      : now;

    // Execute widgets sequentially to avoid N concurrent expensive JSONB queries
    // that can exhaust PG connections and crash the process
    const results: WidgetQueryResult[] = [];
    for (const widget of dashboard.widgets as DashboardWidget[]) {
      const widgetResult = await (async () => {
        // Merge dashboard-level filters with widget-level filters
        // Dashboard-level propertyFilters are exact-match only; runtime ones
        // support all operators (eq, contains, exists, in).
        const dashboardProps = dashboard.filters?.propertyFilters;
        const runtimePF = input.propertyFilters;
        const mergedPF =
          dashboardProps || runtimePF
            ? {
                properties: {
                  ...dashboardProps,
                  ...runtimePF?.properties,
                },
                propertyKeys: runtimePF?.propertyKeys,
                propertyPatterns: runtimePF?.propertyPatterns,
                propertyInValues: runtimePF?.propertyInValues,
              }
            : undefined;

        const mergedFilters = {
          connectionIds:
            widget.filter?.connectionIds ??
            dashboard.filters?.connectionIds ??
            undefined,
          virtualMcpIds: dashboard.filters?.virtualMcpIds ?? undefined,
          toolNames:
            widget.filter?.toolNames ??
            dashboard.filters?.toolNames ??
            undefined,
          startDate,
          endDate,
          propertyFilters: mergedPF,
        };

        try {
          const result = await ctx.storage.monitoring.aggregate({
            organizationId: org.id,
            path: widget.source.path,
            from: widget.source.from,
            aggregation: widget.aggregation.fn as AggregationFunction,
            groupBy: widget.aggregation.groupBy,
            groupByColumn: widget.aggregation.groupByColumn as
              | GroupByColumn
              | undefined,
            interval: widget.aggregation.interval,
            filters: mergedFilters,
          });

          return {
            widgetId: widget.id,
            value: result.value,
            groups: result.groups,
            timeseries: result.timeseries,
          };
        } catch (error) {
          console.error(`Widget ${widget.id} aggregation failed:`, error);
          return {
            widgetId: widget.id,
            value: null,
            groups: undefined,
            timeseries: undefined,
          };
        }
      })();
      results.push(widgetResult);
    }

    return {
      dashboardId: input.dashboardId,
      results,
      timeRange: {
        startDate: startDate.toISOString(),
        endDate: endDate.toISOString(),
      },
    };
  },
});
