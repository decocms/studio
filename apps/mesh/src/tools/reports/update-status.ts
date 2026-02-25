/**
 * REPORTS_UPDATE_STATUS Tool
 *
 * Updates the lifecycle status of a report (unread → read → dismissed).
 * Implements REPORTS_BINDING - optional tool for inbox workflow.
 */

import { ReportLifecycleStatusSchema } from "@decocms/bindings";
import { requireOrganization } from "@/core/mesh-context";
import { defineTool } from "@/core/define-tool";
import { z } from "zod";

const ReportsUpdateStatusInputSchema = z.object({
  reportId: z.string().describe("Report identifier"),
  lifecycleStatus: ReportLifecycleStatusSchema.describe(
    "New lifecycle status for the report",
  ),
});

const ReportsUpdateStatusOutputSchema = z.object({
  success: z.boolean().describe("Whether the operation succeeded"),
  message: z.string().optional().describe("Human-readable result message"),
});

export const REPORTS_UPDATE_STATUS = defineTool({
  name: "REPORTS_UPDATE_STATUS",
  description:
    "Update the lifecycle status of a report (unread, read, dismissed)",
  annotations: {
    title: "Update Report Status",
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  inputSchema: ReportsUpdateStatusInputSchema,
  outputSchema: ReportsUpdateStatusOutputSchema,
  handler: async (input, ctx) => {
    const org = requireOrganization(ctx);
    await ctx.access.check();

    const result = await ctx.storage.reports.updateLifecycleStatus(
      input.reportId,
      org.id,
      input.lifecycleStatus,
    );

    return {
      success: result.success,
      message: result.success
        ? `Report status updated to ${input.lifecycleStatus}`
        : "Report not found",
    };
  },
});
