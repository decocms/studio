/**
 * Deco Blocks Well-Known Binding
 *
 * Defines the interface for exposing Deco block and loader definitions.
 * Any MCP that implements this binding can provide block/loader metadata
 * to the site-editor and other consumers.
 *
 * This binding includes:
 * - BLOCKS_LIST: Return all block and section definitions with their JSON Schemas
 * - LOADERS_LIST: Return all loader definitions with return type schemas
 */

import { z } from "zod";
import type { Binder, ToolBinder } from "../core/binder";

// ============================================================================
// Shared Schemas
// ============================================================================

/**
 * Block kind discriminates between section, loader, and generic block components.
 */
export const BlockKindSchema = z.enum(["section", "loader", "block"]);
export type BlockKind = z.infer<typeof BlockKindSchema>;

/**
 * A single block or section definition returned by BLOCKS_LIST.
 */
export const BlockDefinitionSchema = z.object({
  name: z.string().describe("File stem (e.g. 'ProductShelf')"),
  filePath: z.string().describe("Absolute path to the source file"),
  kind: BlockKindSchema.describe("Discriminated type of the component"),
  propsSchema: z
    .record(z.string(), z.unknown())
    .describe("JSON Schema for the component props"),
});
export type BlockDefinition = z.infer<typeof BlockDefinitionSchema>;

/**
 * A loader definition returned by LOADERS_LIST.
 * Extends BlockDefinition with a return type schema.
 */
export const LoaderDefinitionSchema = BlockDefinitionSchema.extend({
  kind: z.literal("loader").describe("Always 'loader' for loader definitions"),
  returnType: z
    .record(z.string(), z.unknown())
    .describe("JSON Schema for the loader return type"),
});
export type LoaderDefinition = z.infer<typeof LoaderDefinitionSchema>;

// ============================================================================
// Tool Schemas
// ============================================================================

/**
 * BLOCKS_LIST - Return all block and section definitions with their props schemas
 */
export const BlocksListInputSchema = z.object({});

export const BlocksListOutputSchema = z.object({
  blocks: z
    .array(BlockDefinitionSchema)
    .describe("List of block and section definitions"),
});

export type BlocksListInput = z.infer<typeof BlocksListInputSchema>;
export type BlocksListOutput = z.infer<typeof BlocksListOutputSchema>;

/**
 * LOADERS_LIST - Return all loader definitions (extends block with returnType)
 */
export const LoadersListInputSchema = z.object({});

export const LoadersListOutputSchema = z.object({
  loaders: z
    .array(LoaderDefinitionSchema)
    .describe("List of loader definitions"),
});

export type LoadersListInput = z.infer<typeof LoadersListInputSchema>;
export type LoadersListOutput = z.infer<typeof LoadersListOutputSchema>;

// ============================================================================
// Binding Definition
// ============================================================================

/**
 * Deco Blocks Binding
 *
 * Defines the interface for exposing Deco block/loader definitions.
 * Any MCP that implements this binding can be used with the site-editor plugin
 * and other Deco consumers.
 *
 * Required tools:
 * - BLOCKS_LIST: Return all block and section definitions with props schemas
 * - LOADERS_LIST: Return all loader definitions with return type schemas
 */
export const DECO_BLOCKS_BINDING = [
  {
    name: "BLOCKS_LIST" as const,
    inputSchema: BlocksListInputSchema,
    outputSchema: BlocksListOutputSchema,
  } satisfies ToolBinder<"BLOCKS_LIST", BlocksListInput, BlocksListOutput>,
  {
    name: "LOADERS_LIST" as const,
    inputSchema: LoadersListInputSchema,
    outputSchema: LoadersListOutputSchema,
  } satisfies ToolBinder<"LOADERS_LIST", LoadersListInput, LoadersListOutput>,
] as const satisfies Binder;

export type DecoBlocksBinding = typeof DECO_BLOCKS_BINDING;
