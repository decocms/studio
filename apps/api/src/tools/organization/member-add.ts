/**
 * ORGANIZATION_MEMBER_ADD Tool
 *
 * Add a member to an organization
 */

import { z } from "zod";
import { posthog } from "../../posthog";
import { defineTool } from "../../core/define-tool";
import { getUserId, requireAuth } from "../../core/studio-context";
import { canAssignRole } from "@decocms/shared/auth/roles";

export const ORGANIZATION_MEMBER_ADD = defineTool({
  name: "ORGANIZATION_MEMBER_ADD",
  description:
    "Invite a member to the organization by email with an assigned role.",
  annotations: {
    title: "Add Organization Member",
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  inputSchema: z.object({
    organizationId: z.string().optional(), // Optional: defaults to active organization
    userId: z.string(),
    role: z.array(z.string()), // Array of role names (e.g., ["admin"], ["user"])
  }),

  outputSchema: z.object({
    id: z.string(),
    organizationId: z.string(),
    userId: z.string(),
    role: z.union([z.string(), z.array(z.string())]), // Better Auth can return string or array
    createdAt: z.string().datetime().describe("ISO 8601 timestamp"),
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

    // Validate organization ID matches context
    if (organizationId !== ctx.organization?.id) {
      throw new Error(
        "Organization ID does not match authenticated organization",
      );
    }

    // Validate the caller is allowed to assign every target role. `ctx.auth.user?.role`
    // reflects the session's ACTIVE org, which can differ from `organizationId` here
    // (an org-scoped call can target an org the caller merely holds membership in) —
    // using it would let an owner/admin of a DIFFERENT org assign "owner" in this one.
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

    // Add member via Better Auth
    const result = await ctx.boundAuth.organization.addMember({
      organizationId,
      userId: input.userId,
      role: input.role,
    });

    if (!result) {
      throw new Error("Failed to add member");
    }

    const actorId = getUserId(ctx);
    if (actorId) {
      posthog.capture({
        distinctId: actorId,
        event: "organization_member_added",
        groups: { organization: organizationId },
        properties: {
          organization_id: organizationId,
          added_user_id: input.userId,
          role: input.role,
        },
      });
    }

    // Better Auth returns role as string, but we accept string or array
    // Convert dates to ISO strings for JSON Schema compatibility
    return {
      ...result,
      role: result.role as string | string[],
      createdAt:
        result.createdAt instanceof Date
          ? result.createdAt.toISOString()
          : result.createdAt,
    };
  },
});
