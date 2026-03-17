/**
 * VIRTUAL_MCP_DELETE Tool
 *
 * Delete a virtual MCP with collection binding compliance.
 */

import { z } from "zod";
import { defineTool } from "../../core/define-tool";
import { requireAuth, requireOrganization } from "../../core/mesh-context";
import { VirtualMCPEntitySchema } from "./schema";

/**
 * Input schema for deleting a virtual MCP
 */
const DeleteInputSchema = z.object({
  id: z.string().describe("ID of the virtual MCP to delete"),
});

export type DeleteVirtualMCPInput = z.infer<typeof DeleteInputSchema>;

/**
 * Output schema for virtual MCP delete
 */
const DeleteOutputSchema = z.object({
  item: VirtualMCPEntitySchema.describe("The deleted virtual MCP entity"),
});

export const VIRTUAL_MCP_DELETE = defineTool({
  name: "VIRTUAL_MCP_DELETE",
  description: "Permanently delete a Virtual MCP and its virtual tools.",
  annotations: {
    title: "Delete Virtual MCP",
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

    // Get the virtual MCP before deleting (to return it)
    const existing = await ctx.storage.virtualMcps.findById(input.id);
    if (!existing) {
      throw new Error(`Virtual MCP not found: ${input.id}`);
    }
    if (existing.organization_id !== organization.id) {
      throw new Error(`Virtual MCP not found: ${input.id}`);
    }

    // Delete the virtual MCP (connections are deleted via CASCADE)
    await ctx.storage.virtualMcps.delete(input.id);

    // Return virtual MCP entity directly (already in correct format)
    return {
      item: existing,
    };
  },
});
