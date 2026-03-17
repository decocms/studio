/**
 * PROJECT_GET Tool
 *
 * Get a project by ID or slug
 */

import { z } from "zod";
import { defineTool } from "../../core/define-tool";
import { requireAuth } from "../../core/mesh-context";
import { serializedProjectSchema } from "./schema";

export const PROJECT_GET = defineTool({
  name: "PROJECT_GET" as const,
  description: "Get a project's full configuration by ID or slug.",
  annotations: {
    title: "Get Project",
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  inputSchema: z
    .object({
      organizationId: z.string().describe("Organization ID"),
      projectId: z
        .string()
        .optional()
        .describe("Project ID (either this or slug required)"),
      slug: z
        .string()
        .optional()
        .describe("Project slug (either this or projectId required)"),
    })
    .refine((data) => data.projectId || data.slug, {
      message: "Either projectId or slug must be provided",
    }),

  outputSchema: z.object({
    project: serializedProjectSchema.nullable(),
  }),

  handler: async (input, ctx) => {
    // Require authentication
    requireAuth(ctx);

    // Check authorization
    await ctx.access.check();

    let project = null;

    if (input.projectId) {
      project = await ctx.storage.projects.get(input.projectId);
    } else if (input.slug) {
      project = await ctx.storage.projects.getBySlug(
        input.organizationId,
        input.slug,
      );
    }

    if (!project) {
      return { project: null };
    }

    return {
      project: {
        id: project.id,
        organizationId: project.organizationId,
        slug: project.slug,
        name: project.name,
        description: project.description,
        enabledPlugins: project.enabledPlugins,
        ui: project.ui,
        createdAt:
          project.createdAt instanceof Date
            ? project.createdAt.toISOString()
            : project.createdAt,
        updatedAt:
          project.updatedAt instanceof Date
            ? project.updatedAt.toISOString()
            : project.updatedAt,
      },
    };
  },
});
