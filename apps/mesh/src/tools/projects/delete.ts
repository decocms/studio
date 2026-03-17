/**
 * PROJECT_DELETE Tool
 *
 * Delete a project (cannot delete org-admin)
 */

import { z } from "zod";
import { ORG_ADMIN_PROJECT_SLUG } from "@decocms/mesh-sdk";
import { defineTool } from "../../core/define-tool";
import { requireAuth } from "../../core/mesh-context";

export const PROJECT_DELETE = defineTool({
  name: "PROJECT_DELETE" as const,
  description:
    "Permanently delete a project. The default org-admin project cannot be deleted.",
  annotations: {
    title: "Delete Project",
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: true,
    openWorldHint: false,
  },
  inputSchema: z.object({
    projectId: z.string().describe("Project ID to delete"),
  }),

  outputSchema: z.object({
    success: z.boolean(),
    message: z.string().optional(),
  }),

  handler: async (input, ctx) => {
    // Require authentication
    requireAuth(ctx);

    // Check authorization
    await ctx.access.check();

    const { projectId } = input;

    // Get project to check if it's org-admin
    const project = await ctx.storage.projects.get(projectId);
    if (!project) {
      return { success: false, message: "Project not found" };
    }

    if (project.slug === ORG_ADMIN_PROJECT_SLUG) {
      return { success: false, message: "Cannot delete the org-admin project" };
    }

    const success = await ctx.storage.projects.delete(projectId);
    return { success };
  },
});
