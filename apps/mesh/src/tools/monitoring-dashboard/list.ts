/**
 * MONITORING_DASHBOARD_LIST Tool
 *
 * Lists all monitoring dashboards for the organization.
 */

import { requireOrganization } from "@/core/mesh-context";
import { defineTool } from "../../core/define-tool";
import { z } from "zod";
import { MonitoringDashboardSchema } from "./schema";

export const MONITORING_DASHBOARD_LIST = defineTool({
  name: "MONITORING_DASHBOARD_LIST",
  description:
    "List all monitoring dashboards with their widget configurations.",
  annotations: {
    title: "List Monitoring Dashboards",
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  inputSchema: z.object({}),
  outputSchema: z.object({
    dashboards: z
      .array(MonitoringDashboardSchema)
      .describe("List of dashboards"),
    total: z.number().describe("Total number of dashboards"),
  }),
  handler: async (_input, ctx) => {
    const org = requireOrganization(ctx);

    const dashboards = await ctx.storage.monitoringDashboards.list(org.id);

    return {
      dashboards: dashboards.map((d) => ({
        id: d.id,
        organizationId: d.organizationId,
        name: d.name,
        description: d.description,
        filters: d.filters,
        widgets: d.widgets,
        createdBy: d.createdBy,
        createdAt:
          d.createdAt instanceof Date ? d.createdAt.toISOString() : d.createdAt,
        updatedAt:
          d.updatedAt instanceof Date ? d.updatedAt.toISOString() : d.updatedAt,
      })),
      total: dashboards.length,
    };
  },
});
