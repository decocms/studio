/**
 * MEMBER_TAGS_SET Tool
 *
 * Set tags for a member (replaces all existing tags)
 */

import { z } from "zod";
import { defineTool } from "../../core/define-tool";
import { requireAuth, requireOrganization } from "../../core/mesh-context";

export const MEMBER_TAGS_SET = defineTool({
  name: "MEMBER_TAGS_SET",
  description:
    "Replace all tags on a member with the given set. Pass empty array to clear.",
  annotations: {
    title: "Set Member Tags",
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: true,
    openWorldHint: false,
  },
  inputSchema: z.object({
    memberId: z.string().describe("Member ID"),
    tagIds: z.array(z.string()).describe("Array of tag IDs to assign"),
  }),

  outputSchema: z.object({
    success: z.boolean(),
    tags: z.array(
      z.object({
        id: z.string(),
        organizationId: z.string(),
        name: z.string(),
        createdAt: z.string().describe("ISO 8601 timestamp"),
      }),
    ),
  }),

  handler: async (input, ctx) => {
    requireAuth(ctx);
    await ctx.access.check();

    const organization = requireOrganization(ctx);

    // Verify member belongs to this organization
    const memberInOrg = await ctx.storage.tags.verifyMemberOrg(
      input.memberId,
      organization.id,
    );
    if (!memberInOrg) {
      throw new Error(
        `Member not found in this organization: ${input.memberId}`,
      );
    }

    // Verify all tags belong to this organization
    for (const tagId of input.tagIds) {
      const tag = await ctx.storage.tags.getTag(tagId);
      if (!tag) {
        throw new Error(`Tag not found: ${tagId}`);
      }
      if (tag.organizationId !== organization.id) {
        throw new Error(`Tag does not belong to this organization: ${tagId}`);
      }
    }

    // Set the tags
    await ctx.storage.tags.setMemberTags(input.memberId, input.tagIds);

    // Return the updated tags
    const tags = await ctx.storage.tags.getMemberTags(input.memberId);

    return {
      success: true,
      tags: tags.map((tag) => ({
        ...tag,
        createdAt:
          tag.createdAt instanceof Date
            ? tag.createdAt.toISOString()
            : String(tag.createdAt),
      })),
    };
  },
});
