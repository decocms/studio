/**
 * ORGANIZATION_LIST Tool
 *
 * List all organizations the user has access to
 */

import { z } from "zod";
import { defineTool } from "../../core/define-tool";
import { getUserId, requireAuth } from "../../core/mesh-context";

export const ORGANIZATION_LIST = defineTool({
  name: "ORGANIZATION_LIST",
  description: "List organizations the current user belongs to.",
  annotations: {
    title: "List Organizations",
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  _meta: { ui: { visibility: "app" } },
  inputSchema: z.object({
    userId: z.string().optional(), // Optional: filter by user
  }),

  outputSchema: z.object({
    organizations: z.array(
      z.object({
        id: z.string(),
        name: z.string(),
        slug: z.string(),
        logo: z.string().nullable().optional(),
        metadata: z.any().optional(),
        createdAt: z.string().datetime().describe("ISO 8601 timestamp"),
      }),
    ),
  }),

  handler: async (input, ctx) => {
    // Require authentication
    requireAuth(ctx);

    // // Check authorization
    await ctx.access.check();

    // // Get current user ID
    const currentUserId = getUserId(ctx);
    const userId = input.userId || currentUserId;

    if (!userId) {
      throw new Error("User ID required to list organizations");
    }

    const organizations = await ctx.boundAuth.organization.list(userId);

    // Convert dates to ISO strings for JSON Schema compatibility
    // Filter out archived organizations
    return {
      organizations: organizations
        .filter(
          (org: (typeof organizations)[number]) =>
            org.metadata?.archived !== true,
        )
        .map((org: (typeof organizations)[number]) => ({
          ...org,
          createdAt:
            org.createdAt instanceof Date
              ? org.createdAt.toISOString()
              : org.createdAt,
        })),
    };
  },
});
