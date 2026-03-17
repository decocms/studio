/**
 * MEMBER_TAGS_GET Tool
 *
 * Get tags assigned to a member
 */

import { z } from "zod";
import { defineTool } from "../../core/define-tool";
import { requireAuth, requireOrganization } from "../../core/mesh-context";

export const MEMBER_TAGS_GET = defineTool({
  name: "MEMBER_TAGS_GET",
  description: "Get all tags currently assigned to a specific member.",
  annotations: {
    title: "Get Member Tags",
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  inputSchema: z.object({
    memberId: z.string().describe("Member ID"),
  }),

  outputSchema: z.object({
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

    const tags = await ctx.storage.tags.getMemberTags(input.memberId);

    return {
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
