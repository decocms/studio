/**
 * Virtual Tool Entity Schema
 *
 * Virtual tools are custom tools defined on Virtual MCPs with JavaScript code
 * that executes in a QuickJS sandbox. They can reference tools from other
 * connections using the flat namespace pattern (tools.TOOL_NAME(args)).
 *
 * Virtual tools are stored in the `tools` JSON column of the connections table
 * (for VIRTUAL connections). They are distinguished by the presence of
 * `_meta["mcp.mesh"]["tool.fn"]` containing the executable JavaScript code.
 */

import { z } from "zod";

/**
 * Tool annotations schema from MCP spec (internal use)
 */
const ToolAnnotationsSchema = z.object({
  title: z.string().optional(),
  readOnlyHint: z.boolean().optional(),
  destructiveHint: z.boolean().optional(),
  idempotentHint: z.boolean().optional(),
  openWorldHint: z.boolean().optional(),
});

type ToolAnnotations = z.infer<typeof ToolAnnotationsSchema>;

/**
 * Deco Studio virtual tool metadata (internal use)
 * Contains the JavaScript code that implements the tool
 */
const VirtualToolMetaSchema = z.object({
  "tool.fn": z
    .string()
    .describe(
      "JavaScript ES module code that exports a default async function",
    ),
});

type VirtualToolMeta = z.infer<typeof VirtualToolMetaSchema>;

/**
 * Virtual tool entity schema
 * Represents a tool defined with JavaScript code on a Virtual MCP
 */
export const VirtualToolEntitySchema = z.object({
  // Tool identity
  id: z
    .string()
    .describe("Unique identifier for the virtual tool (auto-generated)"),
  name: z
    .string()
    .min(1)
    .max(255)
    .describe("Tool name (must be unique within the Virtual MCP)"),
  description: z
    .string()
    .optional()
    .describe("Human-readable description of what the tool does"),

  // Tool interface
  inputSchema: z
    .record(z.string(), z.unknown())
    .describe("JSON Schema defining the tool's input parameters"),
  outputSchema: z
    .record(z.string(), z.unknown())
    .optional()
    .describe("JSON Schema defining the tool's output (optional)"),
  annotations: ToolAnnotationsSchema.optional().describe(
    "MCP tool annotations",
  ),

  // Virtual tool code
  code: z
    .string()
    .describe(
      "JavaScript ES module code. Must export default an async function: export default async (tools, args) => { ... }",
    ),

  // Dependency tracking
  connection_dependencies: z
    .array(z.string())
    .describe(
      "Connection IDs that this tool depends on (specified by the creator)",
    ),

  // Audit fields
  created_at: z.string().describe("When the virtual tool was created"),
  updated_at: z.string().describe("When the virtual tool was last updated"),
});

export type VirtualToolEntity = z.infer<typeof VirtualToolEntitySchema>;

/**
 * Input schema for creating a virtual tool
 */
export const VirtualToolCreateDataSchema = z.object({
  name: z
    .string()
    .min(1)
    .max(255)
    .describe("Tool name (must be unique within the Virtual MCP)"),
  description: z.string().optional().describe("Human-readable description"),
  inputSchema: z
    .record(z.string(), z.unknown())
    .describe("JSON Schema defining the tool's input parameters"),
  outputSchema: z
    .record(z.string(), z.unknown())
    .optional()
    .describe("JSON Schema for output"),
  annotations: ToolAnnotationsSchema.optional().describe(
    "MCP tool annotations",
  ),
  code: z
    .string()
    .describe(
      "JavaScript ES module code. Must export default an async function: export default async (tools, args) => { ... }",
    ),
  connection_dependencies: z
    .array(z.string())
    .optional()
    .describe(
      "Connection IDs that this tool depends on. Creates indirect aggregations to prevent deletion of referenced connections.",
    ),
});

export type VirtualToolCreateData = z.infer<typeof VirtualToolCreateDataSchema>;

/**
 * Input schema for updating a virtual tool
 */
export const VirtualToolUpdateDataSchema = z.object({
  name: z.string().min(1).max(255).optional().describe("New tool name"),
  description: z
    .string()
    .nullable()
    .optional()
    .describe("New description (null to clear)"),
  inputSchema: z
    .record(z.string(), z.unknown())
    .optional()
    .describe("New input schema"),
  outputSchema: z
    .record(z.string(), z.unknown())
    .nullable()
    .optional()
    .describe("New output schema (null to clear)"),
  annotations: ToolAnnotationsSchema.nullable()
    .optional()
    .describe("New annotations (null to clear)"),
  code: z.string().optional().describe("New JavaScript code"),
  connection_dependencies: z
    .array(z.string())
    .optional()
    .describe(
      "Connection IDs that this tool depends on. Replaces existing dependencies if provided.",
    ),
});

export type VirtualToolUpdateData = z.infer<typeof VirtualToolUpdateDataSchema>;

/**
 * Internal representation of a virtual tool as stored in the tools JSON column
 * This matches the ToolDefinition format with the special _meta["mcp.mesh"] marker
 */
export interface VirtualToolDefinition {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  annotations?: ToolAnnotations;
  _meta: {
    "mcp.mesh": VirtualToolMeta;
    /** Connection IDs that this virtual tool depends on */
    connectionDependencies?: string[];
  };
}

/**
 * Type guard to check if a tool definition is a virtual tool
 */
export function isVirtualTool(
  tool: { _meta?: Record<string, unknown> } | null | undefined,
): tool is VirtualToolDefinition {
  if (!tool?._meta) return false;
  const mcpMesh = tool._meta["mcp.mesh"] as Record<string, unknown> | undefined;
  return typeof mcpMesh?.["tool.fn"] === "string";
}

/**
 * Extract the code from a virtual tool definition
 */
export function getVirtualToolCode(tool: VirtualToolDefinition): string {
  return tool._meta["mcp.mesh"]["tool.fn"];
}

/**
 * Convert a VirtualToolDefinition (storage format) to VirtualToolEntity
 */
export function fromVirtualToolDefinition(
  id: string,
  def: VirtualToolDefinition,
  createdAt: string,
  updatedAt: string,
): VirtualToolEntity {
  return {
    id,
    name: def.name,
    description: def.description,
    inputSchema: def.inputSchema,
    outputSchema: def.outputSchema,
    annotations: def.annotations,
    code: def._meta["mcp.mesh"]["tool.fn"],
    connection_dependencies: def._meta.connectionDependencies ?? [],
    created_at: createdAt,
    updated_at: updatedAt,
  };
}
