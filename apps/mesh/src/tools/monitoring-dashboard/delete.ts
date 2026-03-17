/**
 * MONITORING_DASHBOARD_DELETE Tool
 *
 * Deletes a monitoring dashboard.
 */

import { requireOrganization } from "@/core/mesh-context";
import { defineTool } from "../../core/define-tool";
import { z } from "zod";

export const MONITORING_DASHBOARD_DELETE = defineTool({
  name: "MONITORING_DASHBOARD_DELETE",
  description: "Permanently delete a monitoring dashboard and all its widgets.",
  annotations: {
    title: "Delete Monitoring Dashboard",
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: true,
    openWorldHint: false,
  },
  inputSchema: z.object({
    id: z.string().describe("Dashboard ID to delete"),
  }),
  outputSchema: z.object({
    success: z.boolean().describe("Whether the deletion was successful"),
  }),
  handler: async (input, ctx) => {
    const org = requireOrganization(ctx);

    // First verify the dashboard exists and belongs to this org
    const existing = await ctx.storage.monitoringDashboards.get(input.id);
    if (!existing || existing.organizationId !== org.id) {
      throw new Error(`Dashboard ${input.id} not found`);
    }

    await ctx.storage.monitoringDashboards.delete(input.id);

    return { success: true };
  },
});
