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
  description:
    "Get an organization's details, members, and settings by slug or ID.",
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

    // Filter out expired invitations - Better Auth returns all invitations
    // but acceptInvitation/rejectInvitation will fail for expired ones
    const now = new Date();
    const validInvitations = organization.invitations?.filter(
      (inv: { expiresAt: string | Date }) => new Date(inv.expiresAt) > now,
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
