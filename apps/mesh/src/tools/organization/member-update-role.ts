/**
 * ORGANIZATION_MEMBER_UPDATE_ROLE Tool
 *
 * Update a member's role in an organization
 */

import { z } from "zod";
import { defineTool } from "../../core/define-tool";
import { requireAuth } from "../../core/mesh-context";

export const ORGANIZATION_MEMBER_UPDATE_ROLE = defineTool({
  name: "ORGANIZATION_MEMBER_UPDATE_ROLE",
  description:
    "Change a member's role (e.g., admin, member) within the organization.",
  annotations: {
    title: "Update Member Role",
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: true,
    openWorldHint: false,
  },
  inputSchema: z.object({
    organizationId: z.string().optional(), // Optional: defaults to active organization
    memberId: z.string(),
    role: z.array(z.string()), // Array of role names (e.g., ["admin"], ["user"])
  }),

  outputSchema: z.object({
    id: z.string(),
    organizationId: z.string(),
    userId: z.string(),
    role: z.union([
      z.literal("admin"),
      z.literal("member"),
      z.literal("owner"),
    ]),
    createdAt: z.string().datetime().describe("ISO 8601 timestamp"),
    user: z.object({
      email: z.string(),
      name: z.string(),
      image: z.string().optional(),
    }),
  }),

  handler: async (input, ctx) => {
    // Require authentication
    requireAuth(ctx);

    // Check authorization
    await ctx.access.check();

    // Use active organization if not specified
    const organizationId = input.organizationId || ctx.organization?.id;
    if (!organizationId) {
      throw new Error(
        "Organization ID required (no active organization in context)",
      );
    }

    // Update member role via bound auth client
    const result = await ctx.boundAuth.organization.updateMemberRole({
      organizationId,
      memberId: input.memberId,
      role: input.role,
    });

    if (!result) {
      throw new Error("Failed to update member role");
    }

    // Invalidate cached role
    ctx.invalidateMemberRole?.(result.userId, organizationId);

    // Convert dates to ISO strings for JSON Schema compatibility
    return {
      ...result,
      createdAt:
        result.createdAt instanceof Date
          ? result.createdAt.toISOString()
          : result.createdAt,
    };
  },
});
