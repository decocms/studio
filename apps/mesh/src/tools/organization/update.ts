/**
 * ORGANIZATION_UPDATE Tool
 *
 * Update an existing organization
 */

import { z } from "zod";
import { defineTool } from "../../core/define-tool";
import { requireAuth } from "../../core/mesh-context";

export const ORGANIZATION_UPDATE = defineTool({
  name: "ORGANIZATION_UPDATE",
  description: "Update an organization's name, slug, or description.",
  annotations: {
    title: "Update Organization",
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: true,
    openWorldHint: false,
  },
  inputSchema: z.object({
    id: z.string(),
    slug: z
      .string()
      .min(1)
      .max(50)
      .regex(/^[a-z0-9-]+$/)
      .optional(),
    name: z.string().min(1).max(255).optional(),
    description: z.string().optional(),
  }),

  outputSchema: z.object({
    id: z.string(),
    name: z.string(),
    slug: z.string(),
    logo: z.string().nullable().optional(),
    metadata: z.any().optional(),
    createdAt: z.string().datetime().describe("ISO 8601 timestamp"),
  }),

  handler: async (input, ctx) => {
    // Require authentication
    requireAuth(ctx);

    // Check authorization
    await ctx.access.check();

    // Build update data
    const updateData: Record<string, unknown> = {};
    if (input.name) updateData.name = input.name;
    if (input.slug) updateData.slug = input.slug;
    if (input.description)
      updateData.metadata = { description: input.description };

    // Update organization via Better Auth
    const result = await ctx.boundAuth.organization.update({
      organizationId: input.id,
      data: updateData,
    });

    if (!result) {
      throw new Error("Failed to update organization");
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
