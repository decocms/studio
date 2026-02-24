/**
 * ORGANIZATION_MEMBER_ADD Tool
 *
 * Add a member to an organization
 */

import { z } from "zod";
import { defineTool } from "../../core/define-tool";
import { requireAuth } from "../../core/mesh-context";

export const ORGANIZATION_MEMBER_ADD = defineTool({
  name: "ORGANIZATION_MEMBER_ADD",
  description: "Add a member to an organization",
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

    // Add member via Better Auth
    const result = await ctx.boundAuth.organization.addMember({
      organizationId,
      userId: input.userId,
      role: input.role,
    });

    if (!result) {
      throw new Error("Failed to add member");
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
