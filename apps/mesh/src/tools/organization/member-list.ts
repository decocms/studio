/**
 * ORGANIZATION_MEMBER_LIST Tool
 *
 * List all members in an organization
 */

import { z } from "zod";
import { defineTool } from "../../core/define-tool";
import { requireAuth } from "../../core/mesh-context";

export const ORGANIZATION_MEMBER_LIST = defineTool({
  name: "ORGANIZATION_MEMBER_LIST",
  description: "List all members in the organization with their roles.",
  annotations: {
    title: "List Organization Members",
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  inputSchema: z.object({
    limit: z.number().optional(),
    offset: z.number().optional(),
  }),

  outputSchema: z.object({
    members: z.array(
      z.object({
        id: z.string(),
        organizationId: z.string(),
        userId: z.string(),
        role: z.string(),
        createdAt: z.string().datetime().describe("ISO 8601 timestamp"),
        user: z
          .object({
            id: z.string(),
            name: z.string(),
            email: z.string(),
            image: z.string().optional(),
          })
          .optional(),
      }),
    ),
  }),

  handler: async (input, ctx) => {
    // Require authentication
    requireAuth(ctx);

    // Check authorization
    await ctx.access.check();
    // Use active organization if not specified
    const organizationId = ctx.organization?.id;
    if (!organizationId) {
      throw new Error(
        "Organization ID required (no active organization in context)",
      );
    }

    // List members via Better Auth
    const result = await ctx.boundAuth.organization.listMembers({
      organizationId,
      limit: input.limit,
      offset: input.offset,
    });

    // Convert dates to ISO strings for JSON Schema compatibility
    const members = (Array.isArray(result) ? result : []).map((member) => ({
      ...member,
      createdAt:
        member.createdAt instanceof Date
          ? member.createdAt.toISOString()
          : member.createdAt,
    }));

    return { members };
  },
});
