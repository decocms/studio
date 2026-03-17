/**
 * VIRTUAL_MCP_GET Tool
 *
 * Get a single virtual MCP by ID with collection binding compliance.
 */

import { z } from "zod";
import { defineTool } from "../../core/define-tool";
import { requireAuth, requireOrganization } from "../../core/mesh-context";
import { VirtualMCPEntitySchema } from "./schema";

/**
 * Input schema for getting a virtual MCP
 */
const GetInputSchema = z.object({
  id: z.string().describe("ID of the virtual MCP to retrieve"),
});

export type GetVirtualMCPInput = z.infer<typeof GetInputSchema>;

/**
 * Output schema for virtual MCP get
 */
const GetOutputSchema = z.object({
  item: VirtualMCPEntitySchema.nullable().describe(
    "The retrieved virtual MCP, or null if not found",
  ),
});

export const VIRTUAL_MCP_GET = defineTool({
  name: "VIRTUAL_MCP_GET",
  description:
    "Get a Virtual MCP's configuration, connections, and virtual tools by ID.",
  annotations: {
    title: "Get Virtual MCP",
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

    // Get the virtual MCP
    const virtualMcp = await ctx.storage.virtualMcps.findById(input.id);

    // Check organization ownership
    if (virtualMcp && virtualMcp.organization_id !== organization.id) {
      // Don't leak existence of virtual MCPs in other organizations
      return { item: null };
    }

    if (!virtualMcp) {
      return { item: null };
    }

    // Return virtual MCP entity directly (already in correct format)
    return {
      item: virtualMcp,
    };
  },
});
