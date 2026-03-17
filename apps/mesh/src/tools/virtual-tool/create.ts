/**
 * VIRTUAL_TOOLS_CREATE Tool
 *
 * Create a new virtual tool on a Virtual MCP.
 * The creator specifies which connections the tool depends on.
 * Indirect aggregations are created to prevent deletion of referenced connections.
 */

import { z } from "zod";
import { defineTool } from "../../core/define-tool";
import { requireAuth, requireOrganization } from "../../core/mesh-context";
import { VirtualToolEntitySchema, VirtualToolCreateDataSchema } from "./schema";

/**
 * Input schema for creating a virtual tool
 */
const CreateInputSchema = z.object({
  virtual_mcp_id: z
    .string()
    .describe("ID of the Virtual MCP to add the tool to"),
  data: VirtualToolCreateDataSchema.describe("Virtual tool data"),
});

export type CreateVirtualToolInput = z.infer<typeof CreateInputSchema>;

/**
 * Output schema for virtual tool create
 */
const CreateOutputSchema = z.object({
  item: VirtualToolEntitySchema.describe("The created virtual tool"),
});

export const VIRTUAL_TOOLS_CREATE = defineTool({
  name: "VIRTUAL_TOOLS_CREATE",
  description:
    "Create a virtual tool on a Virtual MCP with custom JavaScript code.\n\n- Code must be a JS ES module: `export default async (tools, args) => { ... }`\n- Specify connection_dependencies for tools this code calls.",
  annotations: {
    title: "Create Virtual Tool",
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: false,
    openWorldHint: false,
  },
  inputSchema: CreateInputSchema,
  outputSchema: CreateOutputSchema,

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

    // Use the dependencies specified by the creator
    const connectionDependencies = input.data.connection_dependencies ?? [];

    // Create the virtual tool
    const tool = await ctx.storage.virtualMcps.createVirtualTool(
      input.virtual_mcp_id,
      input.data,
      connectionDependencies,
    );

    return { item: tool };
  },
});
