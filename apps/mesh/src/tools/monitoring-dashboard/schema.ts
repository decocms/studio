/**
 * Monitoring Dashboard Schema
 *
 * Zod schemas for dashboard tools input/output.
 * Single source of truth for dashboard types.
 */

import { z } from "zod";

// ============================================================================
// Aggregation Function Schema
// ============================================================================

const AggregationFunctionSchema = z
  .enum(["sum", "avg", "min", "max", "count", "count_all", "last"])
  .describe("Aggregation function to apply");

// ============================================================================
// Widget Type Schema
// ============================================================================

const WidgetTypeSchema = z
  .enum(["metric", "timeseries", "table"])
  .describe("Widget display type");

// ============================================================================
// Dashboard Widget Schema
// ============================================================================

const DashboardWidgetSourceSchema = z.object({
  path: z
    .string()
    .describe("JSONPath to extract value, e.g., '$.usage.total_tokens'"),
  from: z
    .enum(["input", "output"])
    .describe("Extract from tool call input or output"),
});

const DashboardWidgetAggregationSchema = z.object({
  fn: AggregationFunctionSchema,
  groupBy: z
    .string()
    .optional()
    .describe("Optional JSONPath for grouping results"),
  interval: z
    .string()
    .optional()
    .describe("For timeseries widgets: interval like '1h', '1d', '15m'"),
});

const DashboardWidgetFilterSchema = z.object({
  connectionIds: z
    .array(z.string())
    .optional()
    .describe("Filter to specific connections"),
  toolNames: z
    .array(z.string())
    .optional()
    .describe("Filter to specific tools"),
});

export const DashboardWidgetSchema = z.object({
  id: z.string().describe("Unique widget identifier"),
  name: z.string().describe("Widget display name"),
  type: WidgetTypeSchema,
  source: DashboardWidgetSourceSchema,
  aggregation: DashboardWidgetAggregationSchema,
  filter: DashboardWidgetFilterSchema.optional(),
});

export type DashboardWidgetInput = z.infer<typeof DashboardWidgetSchema>;

// ============================================================================
// Dashboard Filters Schema
// ============================================================================

export const DashboardFiltersSchema = z.object({
  connectionIds: z
    .array(z.string())
    .optional()
    .describe("Filter to specific connections"),
  virtualMcpIds: z
    .array(z.string())
    .optional()
    .describe("Filter to specific virtual MCPs/agents"),
  toolNames: z
    .array(z.string())
    .optional()
    .describe("Filter to specific tools"),
  propertyFilters: z
    .record(z.string(), z.string())
    .optional()
    .describe(
      "Filter by exact metadata property key=value matches (e.g., { environment: 'production' })",
    ),
});

export type DashboardFiltersInput = z.infer<typeof DashboardFiltersSchema>;

// ============================================================================
// Dashboard Entity Schema
// ============================================================================

export const MonitoringDashboardSchema = z.object({
  id: z.string().describe("Unique dashboard identifier"),
  organizationId: z.string().describe("Organization ID"),
  name: z.string().describe("Dashboard name"),
  description: z.string().nullable().describe("Dashboard description"),
  filters: DashboardFiltersSchema.nullable().describe(
    "Global filters applied to all widgets",
  ),
  widgets: z.array(DashboardWidgetSchema).describe("Widget definitions"),
  createdBy: z.string().describe("User ID who created the dashboard"),
  createdAt: z.string().describe("Creation timestamp"),
  updatedAt: z.string().describe("Last update timestamp"),
});

export type MonitoringDashboardOutput = z.infer<
  typeof MonitoringDashboardSchema
>;

// ============================================================================
// Query Result Schemas
// ============================================================================

const WidgetGroupResultSchema = z.object({
  key: z.string().describe("Group key value"),
  value: z.number().describe("Aggregated value for this group"),
});

const WidgetTimeseriesPointSchema = z.object({
  timestamp: z.string().describe("Time bucket timestamp"),
  value: z.number().describe("Aggregated value for this time bucket"),
});

export const WidgetQueryResultSchema = z.object({
  widgetId: z.string().describe("Widget ID this result is for"),
  value: z.number().nullable().describe("Aggregated value (for metric type)"),
  groups: z
    .array(WidgetGroupResultSchema)
    .optional()
    .describe("Grouped results (when groupBy is specified)"),
  timeseries: z
    .array(WidgetTimeseriesPointSchema)
    .optional()
    .describe("Timeseries data (for timeseries type)"),
});

export type WidgetQueryResult = z.infer<typeof WidgetQueryResultSchema>;
