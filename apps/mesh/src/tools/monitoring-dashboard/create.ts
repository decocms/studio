/**
 * MONITORING_DASHBOARD_CREATE Tool
 *
 * Creates a new monitoring dashboard with widgets.
 */

import { requireOrganization } from "@/core/mesh-context";
import { defineTool } from "../../core/define-tool";
import { z } from "zod";
import {
  DashboardFiltersSchema,
  DashboardWidgetSchema,
  MonitoringDashboardSchema,
} from "./schema";

export const MONITORING_DASHBOARD_CREATE = defineTool({
  name: "MONITORING_DASHBOARD_CREATE",
  description:
    "Create a monitoring dashboard with JSONPath-based aggregation widgets.",
  annotations: {
    title: "Create Monitoring Dashboard",
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: false,
    openWorldHint: false,
  },
  inputSchema: z.object({
    name: z.string().min(1).describe("Dashboard name"),
    description: z.string().optional().describe("Dashboard description"),
    filters: DashboardFiltersSchema.optional().describe(
      "Global filters applied to all widgets",
    ),
    widgets: z
      .array(DashboardWidgetSchema)
      .min(1)
      .describe("Widget definitions (at least one required)"),
  }),
  outputSchema: MonitoringDashboardSchema,
  handler: async (input, ctx) => {
    const org = requireOrganization(ctx);
    const userId = ctx.auth.user?.id;
    if (!userId) {
      throw new Error("User authentication required");
    }

    const dashboard = await ctx.storage.monitoringDashboards.create(
      org.id,
      userId,
      {
        name: input.name,
        description: input.description,
        filters: input.filters,
        widgets: input.widgets,
      },
    );

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
