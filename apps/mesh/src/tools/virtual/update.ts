/**
 * COLLECTION_VIRTUAL_MCP_UPDATE Tool
 *
 * Update an existing virtual MCP with collection binding compliance.
 */

import { z } from "zod";
import { defineTool } from "../../core/define-tool";
import {
  getUserId,
  requireAuth,
  requireOrganization,
} from "../../core/mesh-context";
import { VirtualMCPEntitySchema, VirtualMCPUpdateDataSchema } from "./schema";
import { requireOrgAdminForPinnedField } from "./require-org-admin-for-pin";

/**
 * Input schema for updating a virtual MCP
 */
const UpdateInputSchema = z.object({
  id: z.string().describe("ID of the virtual MCP to update"),
  data: VirtualMCPUpdateDataSchema.describe(
    "Partial virtual MCP data to update",
  ),
});

export type UpdateVirtualMCPInput = z.infer<typeof UpdateInputSchema>;

/**
 * Output schema for virtual MCP update
 */
const UpdateOutputSchema = z.object({
  item: VirtualMCPEntitySchema.describe("The updated virtual MCP entity"),
});

export const COLLECTION_VIRTUAL_MCP_UPDATE = defineTool({
  name: "COLLECTION_VIRTUAL_MCP_UPDATE",
  description: "Update a Virtual MCP's name, slug, or connection list.",
  annotations: {
    title: "Update Virtual MCP",
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

    const userId = getUserId(ctx);
    if (!userId) {
      throw new Error("User ID required to update virtual MCP");
    }

    // Check the virtual MCP exists and belongs to the organization
    const existing = await ctx.storage.virtualMcps.findById(input.id);
    if (!existing) {
      throw new Error(`Virtual MCP not found: ${input.id}`);
    }
    if (existing.organization_id !== organization.id) {
      throw new Error(`Virtual MCP not found: ${input.id}`);
    }

    // Shallow-merge incoming metadata with existing so that callers can send
    // partial metadata updates (e.g. only enabled_plugins) without wiping
    // other fields like instructions or ui.
    const data = { ...input.data };
    if (data.metadata && existing.metadata) {
      data.metadata = { ...existing.metadata, ...data.metadata };
    }

    if (data.pinned !== undefined && data.pinned !== existing.pinned) {
      requireOrgAdminForPinnedField(ctx);
    }

    const virtualMcp = await ctx.storage.virtualMcps.update(
      input.id,
      userId,
      data,
    );

    // Return virtual MCP entity directly (already in correct format)
    return {
      item: virtualMcp,
    };
  },
});
