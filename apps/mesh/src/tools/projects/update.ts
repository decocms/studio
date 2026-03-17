/**
 * PROJECT_UPDATE Tool
 *
 * Update a project's details
 */

import { z } from "zod";
import { defineTool } from "../../core/define-tool";
import { requireAuth } from "../../core/mesh-context";
import { partialProjectUISchema, serializedProjectSchema } from "./schema";
import type { ProjectUI } from "../../storage/types";

export const PROJECT_UPDATE = defineTool({
  name: "PROJECT_UPDATE" as const,
  description: "Update a project's name, description, or enabled plugins.",
  annotations: {
    title: "Update Project",
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: true,
    openWorldHint: false,
  },
  inputSchema: z.object({
    projectId: z.string().describe("Project ID to update"),
    name: z.string().min(1).max(200).optional().describe("New display name"),
    description: z
      .string()
      .max(1000)
      .nullable()
      .optional()
      .describe("New description"),
    enabledPlugins: z
      .array(z.string())
      .nullable()
      .optional()
      .describe("Updated plugin IDs"),
    ui: partialProjectUISchema
      .nullable()
      .optional()
      .describe("Updated UI customization"),
  }),

  outputSchema: z.object({
    project: serializedProjectSchema.nullable(),
  }),

  handler: async (input, ctx) => {
    // Require authentication
    requireAuth(ctx);

    // Check authorization
    await ctx.access.check();

    const { projectId, name, description, enabledPlugins, ui } = input;

    // Build update data, only including fields that were provided
    const updateData: Partial<{
      name: string;
      description: string | null;
      enabledPlugins: string[] | null;
      ui: ProjectUI | null;
    }> = {};

    if (name !== undefined) {
      updateData.name = name;
    }
    if (description !== undefined) {
      updateData.description = description;
    }
    if (enabledPlugins !== undefined) {
      updateData.enabledPlugins = enabledPlugins;
    }
    if (ui !== undefined) {
      // Convert partial UI to full ProjectUI (null for missing fields)
      updateData.ui = ui
        ? {
            banner: ui.banner ?? null,
            bannerColor: ui.bannerColor ?? null,
            icon: ui.icon ?? null,
            themeColor: ui.themeColor ?? null,
          }
        : null;
    }

    const project = await ctx.storage.projects.update(projectId, updateData);

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
