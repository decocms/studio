/**
 * VIRTUAL_TOOLS_UPDATE Tool
 *
 * Update an existing virtual tool on a Virtual MCP.
 * The creator can specify new connection dependencies when updating.
 */

import { z } from "zod";
import { defineTool } from "../../core/define-tool";
import { requireAuth, requireOrganization } from "../../core/mesh-context";
import { VirtualToolEntitySchema, VirtualToolUpdateDataSchema } from "./schema";

/**
 * Input schema for updating a virtual tool
 */
const UpdateInputSchema = z.object({
  virtual_mcp_id: z.string().describe("ID of the Virtual MCP"),
  name: z.string().describe("Current name of the virtual tool to update"),
  data: VirtualToolUpdateDataSchema.describe(
    "Partial virtual tool data to update",
  ),
});

export type UpdateVirtualToolInput = z.infer<typeof UpdateInputSchema>;

/**
 * Output schema for virtual tool update
 */
const UpdateOutputSchema = z.object({
  item: VirtualToolEntitySchema.describe("The updated virtual tool"),
});

export const VIRTUAL_TOOLS_UPDATE = defineTool({
  name: "VIRTUAL_TOOLS_UPDATE",
  description:
    "Update a virtual tool's code, schema, or connection dependencies on a Virtual MCP.",
  annotations: {
    title: "Update Virtual Tool",
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: true,
    openWorldHint: false,
  },
  inputSchema: UpdateInputSchema,
  outputSchema: UpdateOutputSchema,

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

    // Verify the tool exists
    const existingTool = await ctx.storage.virtualMcps.getVirtualTool(
      input.virtual_mcp_id,
      input.name,
    );
    if (!existingTool) {
      throw new Error(`Virtual tool not found: ${input.name}`);
    }

    // Use the dependencies specified by the creator (if provided)
    const connectionDependencies = input.data.connection_dependencies;

    // Update the virtual tool
    const tool = await ctx.storage.virtualMcps.updateVirtualTool(
      input.virtual_mcp_id,
      input.name,
      input.data,
      connectionDependencies,
    );

    return { item: tool };
  },
});
