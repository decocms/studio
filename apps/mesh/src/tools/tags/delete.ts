/**
 * TAGS_DELETE Tool
 *
 * Delete a tag from an organization
 */

import { z } from "zod";
import { defineTool } from "../../core/define-tool";
import { requireAuth, requireOrganization } from "../../core/mesh-context";

export const TAGS_DELETE = defineTool({
  name: "TAGS_DELETE",
  description:
    "Delete a tag and automatically remove it from all assigned members.",
  annotations: {
    title: "Delete Tag",
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: true,
    openWorldHint: false,
  },
  inputSchema: z.object({
    tagId: z.string().describe("Tag ID to delete"),
  }),

  outputSchema: z.object({
    success: z.boolean(),
  }),

  handler: async (input, ctx) => {
    requireAuth(ctx);
    await ctx.access.check();

    const organization = requireOrganization(ctx);

    // Verify the tag belongs to this organization
    const tag = await ctx.storage.tags.getTag(input.tagId);
    if (!tag) {
      throw new Error("Tag not found");
    }
    if (tag.organizationId !== organization.id) {
      throw new Error("Tag does not belong to this organization");
    }

    await ctx.storage.tags.deleteTag(input.tagId);

    return { success: true };
  },
});
