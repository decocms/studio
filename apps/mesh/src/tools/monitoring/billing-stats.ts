/**
 * MONITORING_BILLING_STATS Tool
 *
 * Returns cost analytics from monitoring logs for the billing page:
 * cost timeseries, breakdowns by connection/model/user/tool, and totals.
 *
 * Cost data comes from $.providerMetadata.openrouter.usage.cost captured
 * in monitoring log output during AI model calls.
 */

import { requireOrganization } from "@/core/mesh-context";
import { defineTool } from "../../core/define-tool";
import { z } from "zod";

const COST_PATH = "$.providerMetadata.openrouter.usage.cost";
const COST_FROM = "output" as const;
const MODEL_PATH = "$.model";
const MODEL_FROM = "input" as const;

function periodToDates(period: "7d" | "30d" | "90d"): {
  startDate: Date;
  endDate: Date;
} {
  const endDate = new Date();
  const startDate = new Date(endDate);
  switch (period) {
    case "7d":
      startDate.setDate(startDate.getDate() - 7);
      break;
    case "30d":
      startDate.setDate(startDate.getDate() - 30);
      break;
    case "90d":
      startDate.setDate(startDate.getDate() - 90);
      break;
  }
  return { startDate, endDate };
}

export const MONITORING_BILLING_STATS = defineTool({
  name: "MONITORING_BILLING_STATS",
  description:
    "Get cost analytics from monitoring logs for the billing page: cost over time, breakdown by connection, model, user, and top tools. Cost data is captured from AI model calls routed through OpenRouter.",
  annotations: {
    title: "Get Billing Cost Stats",
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  inputSchema: z.object({
    period: z
      .enum(["7d", "30d", "90d"])
      .default("30d")
      .describe("Time period for analytics"),
  }),
  outputSchema: z.object({
    timeseries: z
      .array(
        z.object({
          timestamp: z.string(),
          cost: z.number(),
          calls: z.number(),
        }),
      )
      .describe("Daily cost and call counts over the period"),
    byConnection: z
      .array(
        z.object({
          title: z.string(),
          cost: z.number(),
          calls: z.number(),
        }),
      )
      .describe("Cost and call counts grouped by connection, sorted by cost"),
    byModel: z
      .array(
        z.object({
          model: z.string(),
          cost: z.number(),
          calls: z.number(),
        }),
      )
      .describe(
        "Cost and call counts grouped by AI model, sorted by cost. Only populated for AI model calls.",
      ),
    byUser: z
      .array(
        z.object({
          userId: z.string(),
          cost: z.number(),
          calls: z.number(),
        }),
      )
      .describe("Cost and call counts grouped by user, sorted by cost"),
    topTools: z
      .array(
        z.object({
          name: z.string(),
          cost: z.number(),
          calls: z.number(),
        }),
      )
      .describe(
        "Top tools by call count, with their associated cost, sorted by calls",
      ),
    totals: z.object({
      cost: z.number().describe("Total cost in USD"),
      calls: z.number().describe("Total tool calls"),
    }),
  }),
  handler: async (input, ctx) => {
    const org = requireOrganization(ctx);
    const { startDate, endDate } = periodToDates(input.period);

    const baseFilters = { startDate, endDate };

    const [
      costTimeseries,
      callTimeseries,
      costByConnection,
      callsByConnection,
      costByModel,
      callsByModel,
      costByUser,
      callsByUser,
      costByTool,
      callsByTool,
    ] = await Promise.all([
      // Cost timeseries (daily)
      ctx.storage.monitoring.aggregate({
        organizationId: org.id,
        path: COST_PATH,
        from: COST_FROM,
        aggregation: "sum",
        interval: "1d",
        filters: baseFilters,
      }),
      // Call count timeseries (daily)
      ctx.storage.monitoring.aggregate({
        organizationId: org.id,
        path: COST_PATH,
        from: COST_FROM,
        aggregation: "count_all",
        interval: "1d",
        filters: baseFilters,
      }),
      // Cost by connection
      ctx.storage.monitoring.aggregate({
        organizationId: org.id,
        path: COST_PATH,
        from: COST_FROM,
        aggregation: "sum",
        groupByColumn: "connection_title",
        filters: baseFilters,
      }),
      // Calls by connection
      ctx.storage.monitoring.aggregate({
        organizationId: org.id,
        path: COST_PATH,
        from: COST_FROM,
        aggregation: "count_all",
        groupByColumn: "connection_title",
        filters: baseFilters,
      }),
      // Cost by model (from input JSON)
      ctx.storage.monitoring.aggregate({
        organizationId: org.id,
        path: COST_PATH,
        from: COST_FROM,
        aggregation: "sum",
        groupBy: MODEL_PATH,
        filters: baseFilters,
      }),
      // Calls by model (from input JSON)
      ctx.storage.monitoring.aggregate({
        organizationId: org.id,
        path: MODEL_PATH,
        from: MODEL_FROM,
        aggregation: "count_all",
        groupBy: MODEL_PATH,
        filters: baseFilters,
      }),
      // Cost by user
      ctx.storage.monitoring.aggregate({
        organizationId: org.id,
        path: COST_PATH,
        from: COST_FROM,
        aggregation: "sum",
        groupByColumn: "user_id",
        filters: baseFilters,
      }),
      // Calls by user
      ctx.storage.monitoring.aggregate({
        organizationId: org.id,
        path: COST_PATH,
        from: COST_FROM,
        aggregation: "count_all",
        groupByColumn: "user_id",
        filters: baseFilters,
      }),
      // Cost by tool
      ctx.storage.monitoring.aggregate({
        organizationId: org.id,
        path: COST_PATH,
        from: COST_FROM,
        aggregation: "sum",
        groupByColumn: "tool_name",
        filters: baseFilters,
      }),
      // Calls by tool
      ctx.storage.monitoring.aggregate({
        organizationId: org.id,
        path: COST_PATH,
        from: COST_FROM,
        aggregation: "count_all",
        groupByColumn: "tool_name",
        filters: baseFilters,
      }),
    ]);

    // Merge timeseries (cost + calls by timestamp)
    const callTimeMap = new Map(
      (callTimeseries.timeseries ?? []).map((p) => [p.timestamp, p.value]),
    );
    const timeseries = (costTimeseries.timeseries ?? []).map((point) => ({
      timestamp: point.timestamp,
      cost: point.value,
      calls: callTimeMap.get(point.timestamp) ?? 0,
    }));

    // Merge by connection
    const connCallMap = new Map(
      (callsByConnection.groups ?? []).map((g) => [g.key, g.value]),
    );
    const byConnection = (costByConnection.groups ?? [])
      .map((g) => ({
        title: g.key,
        cost: g.value,
        calls: connCallMap.get(g.key) ?? 0,
      }))
      .sort((a, b) => b.cost - a.cost);

    // Merge by model
    const modelCallMap = new Map(
      (callsByModel.groups ?? []).map((g) => [g.key, g.value]),
    );
    const byModel = (costByModel.groups ?? [])
      .map((g) => ({
        model: g.key,
        cost: g.value,
        calls: modelCallMap.get(g.key) ?? 0,
      }))
      .sort((a, b) => b.cost - a.cost);

    // Merge by user
    const userCallMap = new Map(
      (callsByUser.groups ?? []).map((g) => [g.key, g.value]),
    );
    const byUser = (costByUser.groups ?? [])
      .map((g) => ({
        userId: g.key,
        cost: g.value,
        calls: userCallMap.get(g.key) ?? 0,
      }))
      .sort((a, b) => b.cost - a.cost);

    // Merge top tools (sorted by calls descending)
    const toolCostMap = new Map(
      (costByTool.groups ?? []).map((g) => [g.key, g.value]),
    );
    const topTools = (callsByTool.groups ?? [])
      .map((g) => ({
        name: g.key,
        cost: toolCostMap.get(g.key) ?? 0,
        calls: g.value,
      }))
      .sort((a, b) => b.calls - a.calls)
      .slice(0, 20);

    // Totals
    const totalCost = timeseries.reduce((sum, p) => sum + p.cost, 0);
    const totalCalls = timeseries.reduce((sum, p) => sum + p.calls, 0);

    return {
      timeseries,
      byConnection,
      byModel,
      byUser,
      topTools,
      totals: {
        cost: totalCost,
        calls: totalCalls,
      },
    };
  },
});
