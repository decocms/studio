/**
 * Reports Well-Known Binding
 *
 * Defines the interface for viewing automated reports.
 * Any MCP that implements this binding can provide reports to the Reports plugin
 * (e.g. performance audits, security scans, accessibility checks).
 *
 * This binding includes:
 * - REPORTS_LIST: List all available reports with metadata
 * - REPORTS_GET: Get a specific report with full content
 */

import { z } from "zod";
import type { Binder, ToolBinder } from "../core/binder";

// ============================================================================
// Shared Schemas
// ============================================================================

/**
 * Report status indicates the overall health/outcome of the report.
 */
export const ReportStatusSchema = z.enum([
  "passing",
  "warning",
  "failing",
  "info",
]);
export type ReportStatus = z.infer<typeof ReportStatusSchema>;

/**
 * A single metric item within a metrics section.
 */
export const MetricItemSchema = z.object({
  label: z.string().describe("Metric label (e.g. 'LCP', 'Performance')"),
  value: z.union([z.number(), z.string()]).describe("Current metric value"),
  unit: z
    .string()
    .optional()
    .describe("Unit of measurement (e.g. 's', 'ms', 'score')"),
  previousValue: z
    .union([z.number(), z.string()])
    .optional()
    .describe("Previous value for delta comparison"),
  status: ReportStatusSchema.optional().describe(
    "Status of this individual metric",
  ),
});
export type MetricItem = z.infer<typeof MetricItemSchema>;

/**
 * A single criterion item within a criteria section.
 */
export const CriterionItemSchema = z.object({
  label: z.string().describe("Short name of the criterion"),
  description: z.string().optional().describe("Longer explanation"),
  status: ReportStatusSchema.optional().describe(
    "Status of this individual criterion (passing/warning/failing/info)",
  ),
});
export type CriterionItem = z.infer<typeof CriterionItemSchema>;

/**
 * A single row within a ranked-list section.
 */
export const RankedListRowSchema = z.object({
  position: z.number().describe("Current rank position"),
  reference_position: z
    .number()
    .optional()
    .describe(
      "Previous rank position before reordering. Used to compute delta automatically (delta = reference_position - position).",
    ),
  delta: z
    .number()
    .optional()
    .describe(
      "Explicit change in position. Ignored when reference_position is provided.",
    ),
  label: z.string().describe("Item name"),
  image: z.string().describe("URL of the item image"),
  values: z
    .array(z.union([z.string(), z.number()]))
    .describe("Values matching columns"),
  note: z
    .union([
      z.string(),
      z.record(z.string(), z.union([z.string(), z.number()])),
    ])
    .optional()
    .describe("Inline annotation or structured key-value metrics"),
});
export type RankedListRow = z.infer<typeof RankedListRowSchema>;

/**
 * Report sections -- polymorphic by type.
 * Sections represent the main content blocks of a report.
 */
export const ReportSectionSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("markdown"),
    content: z.string().describe("Markdown content"),
  }),
  z.object({
    type: z.literal("metrics"),
    title: z.string().optional().describe("Section title"),
    items: z.array(MetricItemSchema).describe("Metric items"),
  }),
  z.object({
    type: z.literal("table"),
    title: z.string().optional().describe("Section title"),
    columns: z.array(z.string()).describe("Column headers"),
    rows: z
      .array(z.array(z.union([z.string(), z.number(), z.null()])))
      .describe("Table rows"),
  }),
  z.object({
    type: z.literal("criteria"),
    title: z.string().optional().describe("Section title"),
    items: z.array(CriterionItemSchema).describe("List of criteria items"),
  }),
  z.object({
    type: z.literal("note"),
    content: z.string().describe("The note text"),
  }),
  z.object({
    type: z.literal("ranked-list"),
    title: z.string().optional().describe("Section title"),
    rows: z.array(RankedListRowSchema).describe("Ranked items"),
  }),
]);
export type ReportSection = z.infer<typeof ReportSectionSchema>;

/**
 * Lifecycle status of a report within the inbox workflow.
 */
export const ReportLifecycleStatusSchema = z.enum([
  "unread",
  "read",
  "dismissed",
]);
export type ReportLifecycleStatus = z.infer<typeof ReportLifecycleStatusSchema>;

/**
 * Summary of a report returned by REPORTS_LIST.
 */
export const ReportSummarySchema = z.object({
  id: z.string().describe("Unique report identifier"),
  title: z.string().describe("Report title"),
  category: z
    .string()
    .describe(
      "Report category (e.g. 'performance', 'security', 'accessibility')",
    ),
  status: ReportStatusSchema.describe("Overall report status"),
  summary: z.string().describe("One-line summary of findings"),
  updatedAt: z.string().describe("ISO 8601 timestamp of last update"),
  source: z
    .string()
    .optional()
    .describe(
      "Agent or service that generated the report (e.g. 'security-auditor', 'performance-monitor')",
    ),
  tags: z
    .array(z.string())
    .optional()
    .describe("Free-form tags for filtering (e.g. 'homepage', 'api', 'ci')"),
  lifecycleStatus: ReportLifecycleStatusSchema.optional().describe(
    "Inbox lifecycle status of the report (default: unread)",
  ),
});
export type ReportSummary = z.infer<typeof ReportSummarySchema>;

/**
 * Full report returned by REPORTS_GET.
 */
export const ReportSchema = ReportSummarySchema.extend({
  sections: z.array(ReportSectionSchema).describe("Ordered content sections"),
});
export type Report = z.infer<typeof ReportSchema>;

// ============================================================================
// UI Helpers
// ============================================================================

/**
 * Groups adjacent criteria+metrics sections into side-by-side pairs for display.
 * In a pair, criteria always goes left and metrics always goes right,
 * regardless of their original order.
 */

type SingleGroup = { type: "single"; section: ReportSection; idx: number };
type SideBySideGroup = {
  type: "side-by-side";
  left: Extract<ReportSection, { type: "criteria" }>;
  right: Extract<ReportSection, { type: "metrics" }>;
  leftIdx: number;
  rightIdx: number;
};
export type SectionGroup = SingleGroup | SideBySideGroup;

export function groupSections(sections: ReportSection[]): SectionGroup[] {
  const groups: SectionGroup[] = [];
  let i = 0;
  while (i < sections.length) {
    const current = sections[i]!;
    const next = sections[i + 1];
    const isPair =
      (current.type === "criteria" && next?.type === "metrics") ||
      (current.type === "metrics" && next?.type === "criteria");

    if (isPair) {
      const isCriteriaFirst = current.type === "criteria";
      const criteria = isCriteriaFirst ? current : next!;
      const metrics = isCriteriaFirst ? next! : current;
      const criteriaIdx = isCriteriaFirst ? i : i + 1;
      const metricsIdx = isCriteriaFirst ? i + 1 : i;
      groups.push({
        type: "side-by-side",
        left: criteria as Extract<ReportSection, { type: "criteria" }>,
        right: metrics as Extract<ReportSection, { type: "metrics" }>,
        leftIdx: criteriaIdx,
        rightIdx: metricsIdx,
      });
      i += 2;
    } else {
      groups.push({ type: "single", section: current, idx: i });
      i += 1;
    }
  }
  return groups;
}

// ============================================================================
// Tool Schemas
// ============================================================================

/**
 * REPORTS_LIST - List all available reports with optional filters
 */
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

export type ReportsListInput = z.infer<typeof ReportsListInputSchema>;
export type ReportsListOutput = z.infer<typeof ReportsListOutputSchema>;

/**
 * REPORTS_GET - Get a specific report with full content
 */
const ReportsGetInputSchema = z.object({
  id: z.string().describe("Report identifier"),
});

const ReportsGetOutputSchema = ReportSchema;

export type ReportsGetInput = z.infer<typeof ReportsGetInputSchema>;
export type ReportsGetOutput = z.infer<typeof ReportsGetOutputSchema>;

/**
 * REPORTS_UPDATE_STATUS - Update the lifecycle status of a report (optional tool)
 */
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

export type ReportsUpdateStatusInput = z.infer<
  typeof ReportsUpdateStatusInputSchema
>;
export type ReportsUpdateStatusOutput = z.infer<
  typeof ReportsUpdateStatusOutputSchema
>;

/**
 * REPORTS_UPSERT - Create or update a report (optional tool)
 * Only Mesh MCP implements this; external MCPs (e.g. GitHub Repo Reports) do not.
 */
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

export type ReportsUpsertInput = z.infer<typeof ReportsUpsertInputSchema>;
export type ReportsUpsertOutput = z.infer<typeof ReportsUpsertOutputSchema>;

// ============================================================================
// Binding Definition
// ============================================================================

/**
 * Reports Binding
 *
 * Defines the interface for viewing and publishing automated reports.
 * Any MCP that implements this binding can be used with the Reports plugin.
 *
 * Required tools:
 * - REPORTS_LIST: List available reports with optional filtering
 * - REPORTS_GET: Get a single report with full content
 *
 * Optional tools:
 * - REPORTS_UPDATE_STATUS: Update the lifecycle status of a report (unread → read → dismissed)
 * - REPORTS_UPSERT: Create or update a report (Mesh MCP only; used by agents/plugins to publish)
 */
export const REPORTS_BINDING = [
  {
    name: "REPORTS_LIST" as const,
    inputSchema: ReportsListInputSchema,
    outputSchema: ReportsListOutputSchema,
  } satisfies ToolBinder<"REPORTS_LIST", ReportsListInput, ReportsListOutput>,
  {
    name: "REPORTS_GET" as const,
    inputSchema: ReportsGetInputSchema,
    outputSchema: ReportsGetOutputSchema,
  } satisfies ToolBinder<"REPORTS_GET", ReportsGetInput, ReportsGetOutput>,
  {
    name: "REPORTS_UPDATE_STATUS" as const,
    inputSchema: ReportsUpdateStatusInputSchema,
    outputSchema: ReportsUpdateStatusOutputSchema,
    opt: true,
  } satisfies ToolBinder<
    "REPORTS_UPDATE_STATUS",
    ReportsUpdateStatusInput,
    ReportsUpdateStatusOutput
  >,
  {
    name: "REPORTS_UPSERT" as const,
    inputSchema: ReportsUpsertInputSchema,
    outputSchema: ReportsUpsertOutputSchema,
    opt: true,
  } satisfies ToolBinder<
    "REPORTS_UPSERT",
    ReportsUpsertInput,
    ReportsUpsertOutput
  >,
] as const satisfies Binder;

export type ReportsBinding = typeof REPORTS_BINDING;
