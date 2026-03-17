/**
 * MONITORING_DASHBOARD_UPDATE Tool
 *
 * Updates an existing monitoring dashboard.
 */

import { requireOrganization } from "@/core/mesh-context";
import { defineTool } from "../../core/define-tool";
import { z } from "zod";
import {
  DashboardFiltersSchema,
  DashboardWidgetSchema,
  MonitoringDashboardSchema,
} from "./schema";

export const MONITORING_DASHBOARD_UPDATE = defineTool({
  name: "MONITORING_DASHBOARD_UPDATE",
  description: "Update a monitoring dashboard's name, filters, or widgets.",
  annotations: {
    title: "Update Monitoring Dashboard",
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: true,
    openWorldHint: false,
  },
  inputSchema: z.object({
    id: z.string().describe("Dashboard ID to update"),
    name: z.string().optional().describe("New dashboard name"),
    description: z
      .string()
      .nullable()
      .optional()
      .describe("New dashboard description"),
    filters: DashboardFiltersSchema.nullable()
      .optional()
      .describe("New global filters"),
    widgets: z
      .array(DashboardWidgetSchema)
      .optional()
      .describe("New widget definitions"),
  }),
  outputSchema: MonitoringDashboardSchema,
  handler: async (input, ctx) => {
    const org = requireOrganization(ctx);

    // First verify the dashboard exists and belongs to this org
    const existing = await ctx.storage.monitoringDashboards.get(input.id);
    if (!existing || existing.organizationId !== org.id) {
      throw new Error(`Dashboard ${input.id} not found`);
    }

    // Build update data
    const updateData: Parameters<
      typeof ctx.storage.monitoringDashboards.update
    >[1] = {};

    if (input.name !== undefined) {
      updateData.name = input.name;
    }
    if (input.description !== undefined) {
      updateData.description = input.description;
    }
    if (input.filters !== undefined) {
      updateData.filters = input.filters;
    }
    if (input.widgets !== undefined) {
      updateData.widgets = input.widgets;
    }

    const dashboard = await ctx.storage.monitoringDashboards.update(
      input.id,
      updateData,
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
