/**
 * PROJECT_CREATE Tool
 *
 * Create a new project in an organization
 */

import { z } from "zod";
import { ORG_ADMIN_PROJECT_SLUG } from "@decocms/mesh-sdk";
import { defineTool } from "../../core/define-tool";
import { requireAuth } from "../../core/mesh-context";
import { partialProjectUISchema, serializedProjectSchema } from "./schema";
import type { ProjectUI } from "../../storage/types";

export const PROJECT_CREATE = defineTool({
  name: "PROJECT_CREATE" as const,
  description:
    "Create a new project to scope connections and tools within an organization.",
  annotations: {
    title: "Create Project",
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: false,
    openWorldHint: false,
  },
  inputSchema: z.object({
    organizationId: z.string().describe("Organization ID"),
    slug: z
      .string()
      .min(1)
      .max(100)
      .regex(/^[a-z0-9-]+$/, "Slug must be lowercase alphanumeric with hyphens")
      .describe("URL-friendly identifier"),
    name: z.string().min(1).max(200).describe("Display name"),
    description: z
      .string()
      .max(1000)
      .nullable()
      .optional()
      .describe("Project description"),
    enabledPlugins: z
      .array(z.string())
      .nullable()
      .optional()
      .describe("Plugin IDs to enable"),
    ui: partialProjectUISchema
      .nullable()
      .optional()
      .describe("UI customization"),
  }),

  outputSchema: z.object({
    project: serializedProjectSchema,
  }),

  handler: async (input, ctx) => {
    // Require authentication
    requireAuth(ctx);

    // Check authorization
    await ctx.access.check();

    const { organizationId, slug, name, description, enabledPlugins, ui } =
      input;

    // Check if slug is reserved
    if (slug === ORG_ADMIN_PROJECT_SLUG) {
      throw new Error(`Slug "${ORG_ADMIN_PROJECT_SLUG}" is reserved`);
    }

    // Check if slug already exists in this org
    const existing = await ctx.storage.projects.getBySlug(organizationId, slug);
    if (existing) {
      throw new Error(
        `Project with slug "${slug}" already exists in this organization`,
      );
    }

    // Convert partial UI to full ProjectUI (null for missing fields)
    const fullUI: ProjectUI | null = ui
      ? {
          banner: ui.banner ?? null,
          bannerColor: ui.bannerColor ?? null,
          icon: ui.icon ?? null,
          themeColor: ui.themeColor ?? null,
        }
      : null;

    const project = await ctx.storage.projects.create({
      organizationId,
      slug,
      name,
      description: description ?? null,
      enabledPlugins: enabledPlugins ?? null,
      ui: fullUI,
    });

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
