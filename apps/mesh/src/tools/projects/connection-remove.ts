/**
 * PROJECT_CONNECTION_REMOVE Tool
 *
 * Remove a connection association from a project.
 * Also cleans up orphaned pinned views referencing the removed connection.
 */

import { z } from "zod";
import { defineTool } from "../../core/define-tool";
import { requireAuth, requireOrganization } from "../../core/mesh-context";
import type { ProjectUI } from "../../storage/types";

export const PROJECT_CONNECTION_REMOVE = defineTool({
  name: "PROJECT_CONNECTION_REMOVE" as const,
  description: "Remove a connection association from a project",
  annotations: {
    title: "Remove Project Connection",
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: true,
    openWorldHint: false,
  },
  inputSchema: z.object({
    projectId: z.string().describe("Project ID"),
    connectionId: z.string().describe("Connection ID to disassociate"),
  }),

  outputSchema: z.object({
    success: z.boolean(),
  }),

  handler: async (input, ctx) => {
    requireAuth(ctx);
    const organization = requireOrganization(ctx);
    await ctx.access.check();

    const { projectId, connectionId } = input;

    const project = await ctx.storage.projects.get(projectId);
    if (!project || project.organizationId !== organization.id) {
      throw new Error(`Project not found: ${projectId}`);
    }

    const connection = await ctx.storage.connections.findById(connectionId);
    if (!connection || connection.organization_id !== organization.id) {
      throw new Error(`Connection not found: ${connectionId}`);
    }

    const removed = await ctx.storage.projectConnections.remove(
      projectId,
      connectionId,
    );

    // Clean up orphaned pinned views referencing this connection
    if (project?.ui?.pinnedViews?.length) {
      const filtered = project.ui.pinnedViews.filter(
        (v) => v.connectionId !== connectionId,
      );
      if (filtered.length !== project.ui.pinnedViews.length) {
        const updatedUI: ProjectUI = {
          ...project.ui,
          pinnedViews: filtered.length > 0 ? filtered : null,
        };
        await ctx.storage.projects.update(projectId, { ui: updatedUI });
      }
    }

    return { success: removed };
  },
});
