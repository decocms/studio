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
  description: "Delete a project (cannot delete org-admin)",
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

    // Before deleting, clean up localhost connections and their Virtual MCPs
    // Only delete connections that are exclusively used by this project
    const pluginConfigs =
      await ctx.storage.projectPluginConfigs.list(projectId);
    for (const config of pluginConfigs) {
      if (!config.connectionId) continue;
      const conn = await ctx.storage.connections.findById(config.connectionId);
      if (
        conn?.connection_url &&
        /^https?:\/\/(?:localhost|127\.0\.0\.1):/.test(conn.connection_url)
      ) {
        // Check if any other project references this connection
        const allConfigs =
          await ctx.storage.projectPluginConfigs.listByConnectionId(conn.id);
        const otherProjectRefs = allConfigs.filter(
          (c) => c.projectId !== projectId,
        );
        if (otherProjectRefs.length > 0) {
          // Another project uses this connection — skip deletion
          continue;
        }

        // Delete Virtual MCPs that use this connection
        const virtualMcps = await ctx.storage.virtualMcps.listByConnectionId(
          project.organizationId,
          conn.id,
        );
        for (const vmcp of virtualMcps) {
          await ctx.storage.virtualMcps.delete(vmcp.id);
        }
        // Delete the connection itself
        await ctx.storage.connections.delete(conn.id);
      }
    }

    const success = await ctx.storage.projects.delete(projectId);
    return { success };
  },
});
