/**
 * VIRTUAL_TOOLS_LIST Tool
 *
 * List all virtual tools for a Virtual MCP with collection binding compliance.
 * Supports pagination via limit/offset.
 */

import { z } from "zod";
import { defineTool } from "../../core/define-tool";
import { requireAuth, requireOrganization } from "../../core/mesh-context";
import { VirtualToolEntitySchema } from "./schema";

/**
 * Input schema for listing virtual tools
 * Extends standard collection list with required virtual_mcp_id
 */
const ListInputSchema = z.object({
  virtual_mcp_id: z
    .string()
    .describe("ID of the Virtual MCP to list tools for"),
  limit: z
    .number()
    .int()
    .min(1)
    .max(1000)
    .optional()
    .describe("Maximum number of items to return"),
  offset: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe("Number of items to skip"),
});

export type ListVirtualToolsInput = z.infer<typeof ListInputSchema>;

/**
 * Output schema for virtual tools list
 */
const ListOutputSchema = z.object({
  items: z.array(VirtualToolEntitySchema).describe("Array of virtual tools"),
  totalCount: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe("Total number of virtual tools"),
  hasMore: z
    .boolean()
    .optional()
    .describe("Whether there are more items available"),
});

export const VIRTUAL_TOOLS_LIST = defineTool({
  name: "VIRTUAL_TOOLS_LIST",
  description:
    "List virtual tools defined on a Virtual MCP with their code and dependencies.",
  annotations: {
    title: "List Virtual Tools",
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  inputSchema: ListInputSchema,
  outputSchema: ListOutputSchema,

  handler: async (input, ctx) => {
    requireAuth(ctx);
    const organization = requireOrganization(ctx);

    await ctx.access.check();

    // Verify the Virtual MCP exists and belongs to the organization
    const virtualMcp = await ctx.storage.virtualMcps.findById(
      input.virtual_mcp_id,
    );
    if (!virtualMcp || virtualMcp.organization_id !== organization.id) {
      return {
        items: [],
        totalCount: 0,
        hasMore: false,
      };
    }

    // Get all virtual tools
    const allTools = await ctx.storage.virtualMcps.listVirtualTools(
      input.virtual_mcp_id,
    );

    // Apply pagination
    const totalCount = allTools.length;
    const offset = input.offset ?? 0;
    const limit = input.limit ?? 100;
    const paginatedTools = allTools.slice(offset, offset + limit);
    const hasMore = offset + limit < totalCount;

    return {
      items: paginatedTools,
      totalCount,
      hasMore,
    };
  },
});
