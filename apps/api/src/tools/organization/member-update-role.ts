/**
 * ORGANIZATION_MEMBER_UPDATE_ROLE Tool
 *
 * Update a member's role in an organization
 */

import { z } from "zod";
import { posthog } from "../../posthog";
import { defineTool } from "../../core/define-tool";
import { getUserId, requireAuth } from "../../core/studio-context";
import { canAssignRole } from "@decocms/shared/auth/roles";

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
    role: z.union([z.string(), z.array(z.string())]), // Better Auth can return string or array
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

    // Validate the caller is allowed to assign every target role. `organizationId`
    // may be an explicit override (not the session's active org), and
    // `ctx.auth.user?.role` only ever reflects the active-org role — using it here
    // would let an owner/admin of a DIFFERENT org assign "owner" in this one.
    // Look up the caller's real membership row in the TARGET org instead.
    // Admins cannot assign "owner" — only owners can.
    const callerMembership = await ctx.db
      .selectFrom("member")
      .select(["role"])
      .where("userId", "=", getUserId(ctx) ?? "")
      .where("organizationId", "=", organizationId)
      .executeTakeFirst();
    if (!canAssignRole(callerMembership?.role, input.role)) {
      throw new Error(
        `Insufficient privileges to assign role "${input.role.join(",")}"`,
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

    const actorId = getUserId(ctx);
    if (actorId) {
      posthog.capture({
        distinctId: actorId,
        event: "organization_member_role_updated",
        groups: { organization: organizationId },
        properties: {
          organization_id: organizationId,
          member_id: input.memberId,
          target_user_id: result.userId,
          new_role: Array.isArray(input.role)
            ? input.role.join(",")
            : input.role,
        },
      });
    }

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
