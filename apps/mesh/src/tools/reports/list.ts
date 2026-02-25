/**
 * REPORTS_LIST Tool
 *
 * Lists all reports for the organization with optional filters.
 * Implements REPORTS_BINDING - serves data from Mesh database.
 */

import { ReportStatusSchema, ReportSummarySchema } from "@decocms/bindings";
import { requireOrganization } from "@/core/mesh-context";
import { defineTool } from "@/core/define-tool";
import { z } from "zod";

const ReportsListInputSchema = z.object({
  category: z
    .string()
    .optional()
    .describe("Filter by category (e.g. 'performance', 'security')"),
  status: ReportStatusSchema.optional().describe("Filter by report status"),
});

const ReportsListOutputSchema = z.object({
  reports: z.array(ReportSummarySchema).describe("List of report summaries"),
});

export const REPORTS_LIST = defineTool({
  name: "REPORTS_LIST",
  description:
    "List all reports for the organization with optional category and status filters",
  annotations: {
    title: "List Reports",
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  inputSchema: ReportsListInputSchema,
  outputSchema: ReportsListOutputSchema,
  handler: async (input, ctx) => {
    const org = requireOrganization(ctx);
    await ctx.access.check();

    const reports = await ctx.storage.reports.list(org.id, {
      category: input.category,
      status: input.status,
    });

    return {
      reports: reports.map((r) => ({
        id: r.id,
        title: r.title,
        category: r.category,
        status: r.status,
        summary: r.summary,
        updatedAt: r.updatedAt,
        source: r.source,
        tags: r.tags,
        lifecycleStatus: r.lifecycleStatus,
      })),
    };
  },
});
