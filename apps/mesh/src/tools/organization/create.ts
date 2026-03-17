/**
 * ORGANIZATION_CREATE Tool
 *
 * Create a new organization using Better Auth organization plugin
 */

import { z } from "zod";
import { defineTool } from "../../core/define-tool";
import { getUserId, requireAuth } from "../../core/mesh-context";

export const ORGANIZATION_CREATE = defineTool({
  name: "ORGANIZATION_CREATE" as const,
  description:
    "Create a new organization. The caller becomes the owner automatically.",
  annotations: {
    title: "Create Organization",
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: false,
    openWorldHint: false,
  },
  inputSchema: z.object({
    slug: z
      .string()
      .min(1)
      .max(50)
      .regex(
        /^[a-z0-9-]+$/,
        "Slug must be lowercase alphanumeric with hyphens",
      ),
    name: z.string().min(1).max(255),
    description: z.string().optional(),
  }),

  outputSchema: z.object({
    id: z.string(),
    name: z.string(),
    slug: z.string(),
    logo: z.string().nullable().optional(),
    metadata: z.any().optional(),
    createdAt: z.string().datetime().describe("ISO 8601 timestamp"),
    members: z.array(z.any()).optional(),
  }),

  handler: async (input, ctx) => {
    // Require authentication
    requireAuth(ctx);

    // Check authorization
    await ctx.access.check();

    // Get user ID
    const userId = getUserId(ctx);
    if (!userId) {
      throw new Error("User ID required to create organization");
    }

    // Create organization via bound auth client
    const result = await ctx.boundAuth.organization.create({
      name: input.name,
      slug: input.slug,
      metadata: input.description
        ? { description: input.description }
        : undefined,
      userId, // Server-side creation
    });

    if (!result) {
      throw new Error("Failed to create organization");
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
