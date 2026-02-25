/**
 * REPORTS_GET Tool
 *
 * Gets a single report by ID with full content.
 * Implements REPORTS_BINDING - serves data from Mesh database.
 */

import { ReportSchema } from "@decocms/bindings";
import { requireOrganization } from "@/core/mesh-context";
import { defineTool } from "@/core/define-tool";
import { z } from "zod";

const ReportsGetInputSchema = z.object({
  id: z.string().describe("Report identifier"),
});

export const REPORTS_GET = defineTool({
  name: "REPORTS_GET",
  description: "Get a report by ID with full content including sections",
  annotations: {
    title: "Get Report",
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  inputSchema: ReportsGetInputSchema,
  outputSchema: ReportSchema,
  handler: async (input, ctx) => {
    const org = requireOrganization(ctx);
    await ctx.access.check();

    const report = await ctx.storage.reports.get(input.id, org.id);

    if (!report) {
      throw new Error(`Report not found: ${input.id}`);
    }

    return report;
  },
});
