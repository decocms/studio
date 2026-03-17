/**
 * MONITORING_DASHBOARD_GET Tool
 *
 * Gets a single monitoring dashboard by ID.
 */

import { requireOrganization } from "@/core/mesh-context";
import { defineTool } from "../../core/define-tool";
import { z } from "zod";
import { MonitoringDashboardSchema } from "./schema";

export const MONITORING_DASHBOARD_GET = defineTool({
  name: "MONITORING_DASHBOARD_GET",
  description:
    "Get a monitoring dashboard's full configuration and widgets by ID.",
  annotations: {
    title: "Get Monitoring Dashboard",
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  inputSchema: z.object({
    id: z.string().describe("Dashboard ID"),
  }),
  outputSchema: MonitoringDashboardSchema.nullable(),
  handler: async (input, ctx) => {
    const org = requireOrganization(ctx);

    const dashboard = await ctx.storage.monitoringDashboards.get(input.id);

    // Ensure dashboard belongs to this organization
    if (!dashboard || dashboard.organizationId !== org.id) {
      return null;
    }

    return {
      id: dashboard.id,
      organizationId: dashboard.organizationId,
      name: dashboard.name,
      description: dashboard.description,
      filters: dashboard.filters,
      widgets: dashboard.widgets,
      createdBy: dashboard.createdBy,
      createdAt:
        dashboard.createdAt instanceof Date
          ? dashboard.createdAt.toISOString()
          : dashboard.createdAt,
      updatedAt:
        dashboard.updatedAt instanceof Date
          ? dashboard.updatedAt.toISOString()
          : dashboard.updatedAt,
    };
  },
});
