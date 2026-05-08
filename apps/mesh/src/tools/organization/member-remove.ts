/**
 * ORGANIZATION_MEMBER_REMOVE Tool
 *
 * Remove a member from an organization
 */

import { z } from "zod";
import { posthog } from "../../posthog";
import { defineTool } from "../../core/define-tool";
import { getUserId, requireAuth } from "../../core/mesh-context";

export const ORGANIZATION_MEMBER_REMOVE = defineTool({
  name: "ORGANIZATION_MEMBER_REMOVE",
  description:
    "Remove a member from the organization. Revokes all their access immediately.",
  annotations: {
    title: "Remove Organization Member",
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: true,
    openWorldHint: false,
  },
  inputSchema: z.object({
    organizationId: z.string().optional(), // Optional: defaults to active organization
    memberIdOrEmail: z.string(), // Member ID or email
  }),

  outputSchema: z.object({
    success: z.boolean(),
    memberIdOrEmail: z.string(),
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

    // Remove member via Better Auth
    await ctx.boundAuth.organization.removeMember({
      organizationId,
      memberIdOrEmail: input.memberIdOrEmail,
    });

    // Invalidate cached role — we don't have the userId here but
    // invalidateOrg would be too broad; the TTL will handle cleanup
    // for removed members since the DB row is gone.

    const actorId = getUserId(ctx);
    if (actorId) {
      posthog.capture({
        distinctId: actorId,
        event: "organization_member_removed",
        groups: { organization: organizationId },
        properties: {
          organization_id: organizationId,
          member_id_or_email: input.memberIdOrEmail,
        },
      });
    }

    return {
      success: true,
      memberIdOrEmail: input.memberIdOrEmail,
    };
  },
});
