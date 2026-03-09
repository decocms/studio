/**
 * ORGANIZATION_GET Tool
 *
 * Get organization details by slug or ID
 */

import { z } from "zod";
import { defineTool } from "../../core/define-tool";
import { requireAuth } from "../../core/mesh-context";

export const ORGANIZATION_GET = defineTool({
  name: "ORGANIZATION_GET",
  description: "Get organization details by slug or ID",
  annotations: {
    title: "Get Organization",
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  inputSchema: z.object({
    // No input needed - uses active organization from context
  }),

  outputSchema: z.object({
    id: z.string(),
    name: z.string(),
    slug: z.string(),
    logo: z.string().nullable().optional(),
    metadata: z.any().optional(),
    createdAt: z.string().datetime().describe("ISO 8601 timestamp"),
    members: z.array(z.any()).optional(),
    invitations: z.array(z.any()).optional(),
  }),

  handler: async (_input, ctx) => {
    // Require authentication
    requireAuth(ctx);

    // Check authorization
    await ctx.access.check();

    // Get full organization via Better Auth
    // This uses the active organization from session
    const organization = await ctx.boundAuth.organization.get();

    if (!organization) {
      throw new Error("No active organization found");
    }

    // Filter to only pending, non-expired invitations.
    // Better Auth's getFullOrganization joins ALL invitations regardless of
    // status or expiry. We keep only what the UI should show:
    // - status must be "pending" (accepted/rejected/cancelled are excluded)
    // - expiresAt must be a valid future date (null/undefined treated as expired)
    const now = new Date();
    const validInvitations = organization.invitations?.filter(
      (inv: { status?: string; expiresAt?: string | Date | null }) =>
        inv.status === "pending" &&
        inv.expiresAt != null &&
        new Date(inv.expiresAt) > now,
    );

    // Convert dates to ISO strings for JSON Schema compatibility
    return {
      ...organization,
      invitations: validInvitations,
      createdAt:
        organization.createdAt instanceof Date
          ? organization.createdAt.toISOString()
          : organization.createdAt,
    };
  },
});
