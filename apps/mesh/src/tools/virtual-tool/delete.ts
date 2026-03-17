/**
 * VIRTUAL_TOOLS_DELETE Tool
 *
 * Delete a virtual tool from a Virtual MCP.
 * Automatically recalculates indirect dependencies after deletion.
 */

import { z } from "zod";
import { defineTool } from "../../core/define-tool";
import { requireAuth, requireOrganization } from "../../core/mesh-context";
import { VirtualToolEntitySchema } from "./schema";

/**
 * Input schema for deleting a virtual tool
 */
const DeleteInputSchema = z.object({
  virtual_mcp_id: z.string().describe("ID of the Virtual MCP"),
  name: z.string().describe("Name of the virtual tool to delete"),
});

export type DeleteVirtualToolInput = z.infer<typeof DeleteInputSchema>;

/**
 * Output schema for virtual tool delete
 */
const DeleteOutputSchema = z.object({
  item: VirtualToolEntitySchema.describe("The deleted virtual tool"),
});

export const VIRTUAL_TOOLS_DELETE = defineTool({
  name: "VIRTUAL_TOOLS_DELETE",
  description: "Remove a virtual tool from a Virtual MCP by name.",
  annotations: {
    title: "Delete Virtual Tool",
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: true,
    openWorldHint: false,
  },
  inputSchema: DeleteInputSchema,
  outputSchema: DeleteOutputSchema,

  handler: async (input, ctx) => {
    requireAuth(ctx);
    const organization = requireOrganization(ctx);

    await ctx.access.check();

    // Verify the Virtual MCP exists and belongs to the organization
    const virtualMcp = await ctx.storage.virtualMcps.findById(
      input.virtual_mcp_id,
    );
    if (!virtualMcp || virtualMcp.organization_id !== organization.id) {
      throw new Error(`Virtual MCP not found: ${input.virtual_mcp_id}`);
    }

    // Get the tool before deleting (to return it)
    const tool = await ctx.storage.virtualMcps.getVirtualTool(
      input.virtual_mcp_id,
      input.name,
    );
    if (!tool) {
      throw new Error(`Virtual tool not found: ${input.name}`);
    }

    // Delete the virtual tool
    await ctx.storage.virtualMcps.deleteVirtualTool(
      input.virtual_mcp_id,
      input.name,
    );

    return { item: tool };
  },
});
