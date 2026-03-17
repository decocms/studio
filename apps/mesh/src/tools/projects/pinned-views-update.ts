/**
 * PROJECT_PINNED_VIEWS_UPDATE Tool
 *
 * Update the pinned views for a project's sidebar
 */

import { z } from "zod";
import { defineTool } from "../../core/define-tool";
import { requireAuth } from "../../core/mesh-context";
import type { ProjectUI, PinnedView } from "../../storage/types";
import { serializedProjectSchema } from "./schema";

const pinnedViewSchema = z.object({
  connectionId: z.string(),
  toolName: z.string(),
  label: z.string(),
  icon: z.string().nullable(),
});

export const PROJECT_PINNED_VIEWS_UPDATE = defineTool({
  name: "PROJECT_PINNED_VIEWS_UPDATE" as const,
  description:
    "Update the pinned sidebar views for a project. Replaces all current pins.",
  annotations: {
    title: "Update Pinned Views",
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: true,
    openWorldHint: false,
  },
  inputSchema: z.object({
    projectId: z.string().describe("Project ID"),
    pinnedViews: z
      .array(pinnedViewSchema)
      .describe("Pinned views to set for the project sidebar"),
  }),

  outputSchema: z.object({
    project: serializedProjectSchema.nullable(),
  }),

  handler: async (input, ctx) => {
    requireAuth(ctx);
    await ctx.access.check();

    const { projectId, pinnedViews } = input;

    const project = await ctx.storage.projects.get(projectId);
    if (!project) {
      throw new Error(`Project not found: ${projectId}`);
    }

    const currentUI = project.ui ?? {
      banner: null,
      bannerColor: null,
      icon: null,
      themeColor: null,
    };

    const updatedUI: ProjectUI = {
      ...currentUI,
      pinnedViews:
        pinnedViews.length > 0 ? (pinnedViews as PinnedView[]) : null,
    };

    const updated = await ctx.storage.projects.update(projectId, {
      ui: updatedUI,
    });

    if (!updated) {
      return { project: null };
    }

    return {
      project: {
        id: updated.id,
        organizationId: updated.organizationId,
        slug: updated.slug,
        name: updated.name,
        description: updated.description,
        enabledPlugins: updated.enabledPlugins,
        ui: updated.ui,
        createdAt:
          updated.createdAt instanceof Date
            ? updated.createdAt.toISOString()
            : updated.createdAt,
        updatedAt:
          updated.updatedAt instanceof Date
            ? updated.updatedAt.toISOString()
            : updated.updatedAt,
      },
    };
  },
});
