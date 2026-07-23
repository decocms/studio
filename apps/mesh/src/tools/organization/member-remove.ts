/**
 * ORGANIZATION_MEMBER_REMOVE Tool
 *
 * Remove a member from an organization
 */

import { z } from "zod";
import { posthog } from "../../posthog";
import { defineTool } from "../../core/define-tool";
import { getUserId, requireAuth } from "../../core/studio-context";

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

    // `ctx.access.check()` above only verified the caller can remove members
    // in `ctx.organization` (the path-resolved org). Without this check, a
    // caller could pass a *different* `input.organizationId` and remove a
    // member from an org they have no membership in at all.
    if (organizationId !== ctx.organization?.id) {
      throw new Error(
        "Organization ID does not match authenticated organization",
      );
    }

    // Remove member via Better Auth
    const removed = await ctx.boundAuth.organization.removeMember({
      organizationId,
      memberIdOrEmail: input.memberIdOrEmail,
    });

    // Invalidate cached role — we don't have the userId here but
    // invalidateOrg would be too broad; the TTL will handle cleanup
    // for removed members since the DB row is gone.

    const actorId = getUserId(ctx);

    // Release the member's paid seat (lifecycle pairing with membership):
    // without this, a removed member's seat keeps counting toward the org's
    // bill and gateway allowance forever. Fail-soft: seat release must never
    // make the (already completed) removal report failure.
    const removedUserId = removed?.member?.userId;
    if (removedUserId) {
      try {
        await ctx.storage.organizationBilling.releaseSeatOnMemberRemoval(
          organizationId,
          removedUserId,
          actorId ?? "system",
        );
      } catch (err) {
        console.error("Failed to release paid seat on member removal:", err);
      }
    }
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
