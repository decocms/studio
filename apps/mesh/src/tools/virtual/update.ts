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
} from "../../core/studio-context";
import { writeAgentPrompts } from "../../file-storage/agent-prompts";
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
  description:
    "Update a Virtual MCP's name, slug, connection list, or kickstart prompts. Pass `prompts` to replace the agent's conversation starters (full set; empty array clears them).",
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

    // `prompts` lives in org-fs, not on the agent row — pull it out before the
    // row update and re-seed separately below.
    const { prompts, ...data } = input.data;
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

    // Re-seed kickstart prompts when provided (full replace; [] clears all).
    // Best-effort: never fail the update over a prompt write.
    if (prompts !== undefined && ctx.orgFs) {
      await writeAgentPrompts(ctx.orgFs, input.id, userId, prompts);
    }

    // Return virtual MCP entity directly (already in correct format)
    return {
      item: virtualMcp,
    };
  },
});
