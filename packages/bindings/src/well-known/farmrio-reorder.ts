/**
 * Farmrio Collection Reorder Binding
 *
 * Defines the interface for the Farmrio DB-based collection reorder MCP.
 * Field names match the actual MCP runtime behavior (verified empirically).
 */

import { z } from "zod";
import type { Binder, ToolBinder } from "../core/binder";

// ============================================================================
// Shared Schemas
// ============================================================================

export const FarmrioCollectionItemSchema = z.object({
  id: z.number().int(),
  farmCollectionId: z.string(),
  decoCollectionId: z.string().optional(),
  title: z.string(),
  isEnabled: z.boolean(),
});
export type FarmrioCollectionItem = z.infer<typeof FarmrioCollectionItemSchema>;

export const FarmrioMetricItemSchema = z.object({
  id: z.number().int().optional(),
  label: z.string(),
  value: z.union([z.number(), z.string()]),
  unit: z.string().optional(),
  status: z.string().optional(),
});
export type FarmrioMetricItem = z.infer<typeof FarmrioMetricItemSchema>;

export const FarmrioCriteriaItemSchema = z.object({
  id: z.number().int().optional(),
  label: z.string(),
  description: z.string().optional(),
});
export type FarmriaCriteriaItem = z.infer<typeof FarmrioCriteriaItemSchema>;

export const FarmrioRankedItemSchema = z.object({
  id: z.number().int().optional(),
  position: z.number().int(),
  delta: z.number().optional(),
  label: z.string(),
  image: z.string().optional(),
  sessions: z.number().optional(),
  selectRate: z.number().optional(),
  addToCartRate: z.number().optional(),
  purchaseRate: z.number().optional(),
  valueSelectRate: z.string().optional(),
  valueAvailability: z.string().optional(),
});
export type FarmrioRankedItem = z.infer<typeof FarmrioRankedItemSchema>;

export const FarmrioSectionSchema = z.object({
  id: z.number().int().optional(),
  reportId: z.number().int().optional(),
  type: z.enum(["metrics", "criteria", "note", "ranked-list"]),
  title: z.string().nullable().optional(),
  content: z.string().nullable().optional(),
  position: z.number().int().optional(),
  metricItems: z.array(FarmrioMetricItemSchema).optional(),
  criteriaItems: z.array(FarmrioCriteriaItemSchema).optional(),
  rankedItems: z.array(FarmrioRankedItemSchema).optional(),
});
export type FarmrioSection = z.infer<typeof FarmrioSectionSchema>;

export const FarmrioReportSummarySchema = z.object({
  id: z.number().int(),
  collectionId: z.number().int(),
  title: z.string(),
  category: z.string().optional(),
  status: z.string().optional(),
  summary: z.string(),
  source: z.string().optional(),
  tags: z.array(z.string()).optional(),
  updatedAt: z.string(),
});
export type FarmrioReportSummary = z.infer<typeof FarmrioReportSummarySchema>;

export const FarmrioReportSchema = FarmrioReportSummarySchema.extend({
  sections: z.array(FarmrioSectionSchema),
});
export type FarmrioReport = z.infer<typeof FarmrioReportSchema>;

// ============================================================================
// Tool Schemas
// ============================================================================

const CollectionListInputSchema = z.object({
  isEnabled: z.boolean().optional(),
  limit: z.number().int().min(1).max(200).optional(),
  offset: z.number().int().min(0).optional(),
});
const CollectionListOutputSchema = z.object({
  success: z.boolean(),
  total: z.number().int().optional(),
  items: z.array(FarmrioCollectionItemSchema).optional(),
  error: z.string().optional(),
});
export type CollectionListInput = z.infer<typeof CollectionListInputSchema>;
export type CollectionListOutput = z.infer<typeof CollectionListOutputSchema>;

const CollectionGetInputSchema = z.object({
  id: z.number().int(),
});
const CollectionGetOutputSchema = z.object({
  success: z.boolean(),
  item: FarmrioCollectionItemSchema.optional(),
  error: z.string().optional(),
});
export type CollectionGetInput = z.infer<typeof CollectionGetInputSchema>;
export type CollectionGetOutput = z.infer<typeof CollectionGetOutputSchema>;

const CollectionCreateInputSchema = z.object({
  farmCollectionId: z.string().min(1),
  decoCollectionId: z.string().optional(),
  title: z.string().min(1),
  isEnabled: z.boolean().optional(),
});
const CollectionCreateOutputSchema = z.object({
  success: z.boolean(),
  item: FarmrioCollectionItemSchema.optional(),
  error: z.string().optional(),
});
export type CollectionCreateInput = z.infer<typeof CollectionCreateInputSchema>;
export type CollectionCreateOutput = z.infer<
  typeof CollectionCreateOutputSchema
>;

const CollectionUpdateInputSchema = z.object({
  id: z.number().int(),
  farmCollectionId: z.string().min(1),
  decoCollectionId: z.string().optional(),
  title: z.string().min(1).optional(),
  isEnabled: z.boolean().optional(),
});
const CollectionUpdateOutputSchema = z.object({
  success: z.boolean(),
  item: FarmrioCollectionItemSchema.optional(),
  error: z.string().optional(),
});
export type CollectionUpdateInput = z.infer<typeof CollectionUpdateInputSchema>;
export type CollectionUpdateOutput = z.infer<
  typeof CollectionUpdateOutputSchema
>;

const ReportListInputSchema = z.object({
  collectionId: z.number().int().optional(),
  limit: z.number().int().min(1).max(200).optional(),
  offset: z.number().int().min(0).optional(),
});
const ReportListOutputSchema = z.object({
  success: z.boolean(),
  total: z.number().int().optional(),
  items: z.array(FarmrioReportSummarySchema).optional(),
  error: z.string().optional(),
});
export type ReportListInput = z.infer<typeof ReportListInputSchema>;
export type ReportListOutput = z.infer<typeof ReportListOutputSchema>;

const ReportGetInputSchema = z.object({
  id: z.number().int(),
});
const ReportGetOutputSchema = z.object({
  success: z.boolean(),
  item: FarmrioReportSchema.optional(),
  error: z.string().optional(),
});
export type ReportGetInput = z.infer<typeof ReportGetInputSchema>;
export type ReportGetOutput = z.infer<typeof ReportGetOutputSchema>;

// ============================================================================
// Binding Definition
// ============================================================================

export const FARMRIO_REORDER_BINDING = [
  {
    name: "collection_list" as const,
    inputSchema: CollectionListInputSchema,
    outputSchema: CollectionListOutputSchema,
  } satisfies ToolBinder<
    "collection_list",
    CollectionListInput,
    CollectionListOutput
  >,
  {
    name: "collection_get" as const,
    inputSchema: CollectionGetInputSchema,
    outputSchema: CollectionGetOutputSchema,
    opt: true,
  } satisfies ToolBinder<
    "collection_get",
    CollectionGetInput,
    CollectionGetOutput
  >,
  {
    name: "collection_create" as const,
    inputSchema: CollectionCreateInputSchema,
    outputSchema: CollectionCreateOutputSchema,
  } satisfies ToolBinder<
    "collection_create",
    CollectionCreateInput,
    CollectionCreateOutput
  >,
  {
    name: "collection_update" as const,
    inputSchema: CollectionUpdateInputSchema,
    outputSchema: CollectionUpdateOutputSchema,
  } satisfies ToolBinder<
    "collection_update",
    CollectionUpdateInput,
    CollectionUpdateOutput
  >,
  {
    name: "report_list" as const,
    inputSchema: ReportListInputSchema,
    outputSchema: ReportListOutputSchema,
  } satisfies ToolBinder<"report_list", ReportListInput, ReportListOutput>,
  {
    name: "report_get" as const,
    inputSchema: ReportGetInputSchema,
    outputSchema: ReportGetOutputSchema,
  } satisfies ToolBinder<"report_get", ReportGetInput, ReportGetOutput>,
] as const satisfies Binder;

export type FarmrioReorderBinding = typeof FARMRIO_REORDER_BINDING;
