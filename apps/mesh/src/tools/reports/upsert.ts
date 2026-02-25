/**
 * REPORTS_UPSERT Tool
 *
 * Creates or updates a report in the Mesh database.
 * Allows agents, CI, or external services to publish reports.
 */

import {
  ReportLifecycleStatusSchema,
  ReportSectionSchema,
  ReportStatusSchema,
} from "@decocms/bindings";
import { requireOrganization } from "@/core/mesh-context";
import { defineTool } from "@/core/define-tool";
import { z } from "zod";

const ReportsUpsertInputSchema = z.object({
  id: z
    .string()
    .optional()
    .describe("Report ID (optional, generated if omitted)"),
  title: z.string().describe("Report title"),
  category: z
    .string()
    .describe(
      "Report category (e.g. 'performance', 'security', 'collection-ranking')",
    ),
  status: ReportStatusSchema.describe("Overall report status"),
  summary: z.string().describe("One-line summary of findings"),
  source: z
    .string()
    .optional()
    .describe(
      "Agent or service that generated the report (e.g. 'collection-reorder', 'security-auditor')",
    ),
  tags: z.array(z.string()).optional().describe("Free-form tags for filtering"),
  lifecycleStatus: ReportLifecycleStatusSchema.optional().describe(
    "Inbox lifecycle status (default: unread)",
  ),
  sections: z
    .array(ReportSectionSchema)
    .describe("Ordered content sections (markdown, metrics, table, etc.)"),
});

const ReportsUpsertOutputSchema = z.object({
  id: z.string().describe("Report identifier"),
  title: z.string(),
  category: z.string(),
  status: ReportStatusSchema,
  summary: z.string(),
  updatedAt: z.string(),
  source: z.string().optional(),
  tags: z.array(z.string()).optional(),
  lifecycleStatus: z.string().optional(),
  sections: z.array(ReportSectionSchema),
});

export const REPORTS_UPSERT = defineTool({
  name: "REPORTS_UPSERT",
  description:
    "Create or update a report in the Mesh database. Use this to publish reports from agents, CI, or external services.",
  annotations: {
    title: "Upsert Report",
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: false,
  },
  inputSchema: ReportsUpsertInputSchema,
  outputSchema: ReportsUpsertOutputSchema,
  handler: async (input, ctx) => {
    const org = requireOrganization(ctx);
    await ctx.access.check();

    const report = await ctx.storage.reports.upsert(org.id, {
      id: input.id,
      title: input.title,
      category: input.category,
      status: input.status,
      summary: input.summary,
      source: input.source,
      tags: input.tags,
      lifecycleStatus: input.lifecycleStatus,
      sections: input.sections,
    });

    return report;
  },
});
