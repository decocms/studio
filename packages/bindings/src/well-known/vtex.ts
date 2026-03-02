/**
 * VTEX Collection Reorder Well-Known Binding
 *
 * Defines the interface for VTEX collection operations required by
 * collection reorder plugins.
 */

import { z } from "zod";
import type { Binder, ToolBinder } from "../core/binder";

// ============================================================================
// Shared Schemas
// ============================================================================

export const VtexPagingSchema = z.object({
  Page: z.number().optional(),
  PageSize: z.number().optional(),
  Total: z.number().optional(),
  Pages: z.number().optional(),
});
export type VtexPaging = z.infer<typeof VtexPagingSchema>;

export const VtexCollectionSchema = z.object({
  Id: z.number(),
  Name: z.string(),
  Searchable: z.boolean(),
  Highlight: z.boolean(),
  DateFrom: z.string().nullable().optional(),
  DateTo: z.string().nullable().optional(),
  TotalSku: z.number().optional(),
  TotalProducts: z.number().optional(),
});
export type VtexCollection = z.infer<typeof VtexCollectionSchema>;

export const VtexCollectionProductSchema = z.object({
  ProductId: z.number(),
  SkuId: z.number().optional(),
  ProductName: z.string(),
  Position: z.number().optional(),
});
export type VtexCollectionProduct = z.infer<typeof VtexCollectionProductSchema>;

// ============================================================================
// Tool Schemas
// ============================================================================

const VtexListCollectionsInputSchema = z.object({
  page: z.number().int().positive().optional(),
  pageSize: z.number().int().positive().optional(),
});
const VtexListCollectionsOutputSchema = z.object({
  Data: z.array(VtexCollectionSchema),
  Paging: VtexPagingSchema.optional(),
});
export type VtexListCollectionsInput = z.infer<
  typeof VtexListCollectionsInputSchema
>;
export type VtexListCollectionsOutput = z.infer<
  typeof VtexListCollectionsOutputSchema
>;

const VtexGetCollectionInputSchema = z.object({
  collectionId: z.number().int().positive(),
});
const VtexGetCollectionOutputSchema = VtexCollectionSchema;
export type VtexGetCollectionInput = z.infer<
  typeof VtexGetCollectionInputSchema
>;
export type VtexGetCollectionOutput = z.infer<
  typeof VtexGetCollectionOutputSchema
>;

const VtexGetCollectionProductsInputSchema = z.object({
  collectionId: z.number().int().positive(),
  page: z.number().int().positive().optional(),
  pageSize: z.number().int().positive().optional(),
});
const VtexGetCollectionProductsOutputSchema = z.object({
  Data: z.array(VtexCollectionProductSchema),
  Paging: VtexPagingSchema.optional(),
});
export type VtexGetCollectionProductsInput = z.infer<
  typeof VtexGetCollectionProductsInputSchema
>;
export type VtexGetCollectionProductsOutput = z.infer<
  typeof VtexGetCollectionProductsOutputSchema
>;

const VtexSearchCollectionsInputSchema = z.object({
  words: z.string().min(1),
});
const VtexSearchCollectionsOutputSchema = z.object({
  Data: z.array(VtexCollectionSchema),
});
export type VtexSearchCollectionsInput = z.infer<
  typeof VtexSearchCollectionsInputSchema
>;
export type VtexSearchCollectionsOutput = z.infer<
  typeof VtexSearchCollectionsOutputSchema
>;

const VtexAddSkuToCollectionInputSchema = z.object({
  subCollectionId: z.number().int().positive(),
  skuId: z.number().int().positive(),
});
const VtexAddSkuToCollectionOutputSchema = z.object({
  SubCollectionId: z.number(),
  SkuId: z.number(),
});
export type VtexAddSkuToCollectionInput = z.infer<
  typeof VtexAddSkuToCollectionInputSchema
>;
export type VtexAddSkuToCollectionOutput = z.infer<
  typeof VtexAddSkuToCollectionOutputSchema
>;

const VtexRemoveSkuFromCollectionInputSchema = z.object({
  subCollectionId: z.number().int().positive(),
  skuId: z.number().int().positive(),
});
const VtexRemoveSkuFromCollectionOutputSchema = z.object({
  success: z.boolean(),
});
export type VtexRemoveSkuFromCollectionInput = z.infer<
  typeof VtexRemoveSkuFromCollectionInputSchema
>;
export type VtexRemoveSkuFromCollectionOutput = z.infer<
  typeof VtexRemoveSkuFromCollectionOutputSchema
>;

export const VtexReorderCollectionInputSchema = z.object({
  collectionId: z.union([z.string().min(1), z.number().int().positive()]),
  productIds: z
    .array(z.union([z.string().min(1), z.number().int().positive()]))
    .min(1)
    .describe("Ordered VTEX product IDs"),
});
export const VtexReorderCollectionOutputSchema = z.object({}).passthrough();
export type VtexReorderCollectionInput = z.infer<
  typeof VtexReorderCollectionInputSchema
>;
export type VtexReorderCollectionOutput = z.infer<
  typeof VtexReorderCollectionOutputSchema
>;

// ============================================================================
// Binding Definition
// ============================================================================

export const VTEX_COLLECTION_REORDER_BINDING = [
  {
    name: "VTEX_LIST_COLLECTIONS" as const,
    inputSchema: VtexListCollectionsInputSchema,
    outputSchema: VtexListCollectionsOutputSchema,
  } satisfies ToolBinder<
    "VTEX_LIST_COLLECTIONS",
    VtexListCollectionsInput,
    VtexListCollectionsOutput
  >,
  {
    name: "VTEX_GET_COLLECTION" as const,
    inputSchema: VtexGetCollectionInputSchema,
    outputSchema: VtexGetCollectionOutputSchema,
  } satisfies ToolBinder<
    "VTEX_GET_COLLECTION",
    VtexGetCollectionInput,
    VtexGetCollectionOutput
  >,
  {
    name: "VTEX_GET_COLLECTION_PRODUCTS" as const,
    inputSchema: VtexGetCollectionProductsInputSchema,
    outputSchema: VtexGetCollectionProductsOutputSchema,
  } satisfies ToolBinder<
    "VTEX_GET_COLLECTION_PRODUCTS",
    VtexGetCollectionProductsInput,
    VtexGetCollectionProductsOutput
  >,
  {
    name: "VTEX_SEARCH_COLLECTIONS" as const,
    inputSchema: VtexSearchCollectionsInputSchema,
    outputSchema: VtexSearchCollectionsOutputSchema,
    opt: true,
  } satisfies ToolBinder<
    "VTEX_SEARCH_COLLECTIONS",
    VtexSearchCollectionsInput,
    VtexSearchCollectionsOutput
  >,
  {
    name: "VTEX_ADD_SKU_TO_COLLECTION" as const,
    inputSchema: VtexAddSkuToCollectionInputSchema,
    outputSchema: VtexAddSkuToCollectionOutputSchema,
    opt: true,
  } satisfies ToolBinder<
    "VTEX_ADD_SKU_TO_COLLECTION",
    VtexAddSkuToCollectionInput,
    VtexAddSkuToCollectionOutput
  >,
  {
    name: "VTEX_REMOVE_SKU_FROM_COLLECTION" as const,
    inputSchema: VtexRemoveSkuFromCollectionInputSchema,
    outputSchema: VtexRemoveSkuFromCollectionOutputSchema,
    opt: true,
  } satisfies ToolBinder<
    "VTEX_REMOVE_SKU_FROM_COLLECTION",
    VtexRemoveSkuFromCollectionInput,
    VtexRemoveSkuFromCollectionOutput
  >,
] as const satisfies Binder;

export type VtexCollectionReorderBinding =
  typeof VTEX_COLLECTION_REORDER_BINDING;

export const VTEX_REORDER_COLLECTION_BINDING = [
  {
    name: "VTEX_REORDER_COLLECTION" as const,
    inputSchema: VtexReorderCollectionInputSchema,
    outputSchema: VtexReorderCollectionOutputSchema,
  } satisfies ToolBinder<
    "VTEX_REORDER_COLLECTION",
    VtexReorderCollectionInput,
    VtexReorderCollectionOutput
  >,
] as const satisfies Binder;

export type VtexReorderCollectionBinding =
  typeof VTEX_REORDER_COLLECTION_BINDING;
