/**
 * VIRTUAL_TOOLS_GET Tool
 *
 * Get a single virtual tool by name from a Virtual MCP.
 */

import { z } from "zod";
import { defineTool } from "../../core/define-tool";
import { requireAuth, requireOrganization } from "../../core/mesh-context";
import { VirtualToolEntitySchema } from "./schema";

/**
 * Input schema for getting a virtual tool
 */
const GetInputSchema = z.object({
  virtual_mcp_id: z.string().describe("ID of the Virtual MCP"),
  name: z.string().describe("Name of the virtual tool to retrieve"),
});

export type GetVirtualToolInput = z.infer<typeof GetInputSchema>;

/**
 * Output schema for virtual tool get
 */
const GetOutputSchema = z.object({
  item: VirtualToolEntitySchema.nullable().describe(
    "The retrieved virtual tool, or null if not found",
  ),
});

export const VIRTUAL_TOOLS_GET = defineTool({
  name: "VIRTUAL_TOOLS_GET",
  description:
    "Get a virtual tool's code, schema, and dependencies by name from a Virtual MCP.",
  annotations: {
    title: "Get Virtual Tool",
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  inputSchema: GetInputSchema,
  outputSchema: GetOutputSchema,

  handler: async (input, ctx) => {
    requireAuth(ctx);
    const organization = requireOrganization(ctx);

    await ctx.access.check();

    // Verify the Virtual MCP exists and belongs to the organization
    const virtualMcp = await ctx.storage.virtualMcps.findById(
      input.virtual_mcp_id,
    );
    if (!virtualMcp || virtualMcp.organization_id !== organization.id) {
      return { item: null };
    }

    // Get the virtual tool
    const tool = await ctx.storage.virtualMcps.getVirtualTool(
      input.virtual_mcp_id,
      input.name,
    );

    return { item: tool };
  },
});
