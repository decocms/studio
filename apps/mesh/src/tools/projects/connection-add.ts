/**
 * PROJECT_CONNECTION_ADD Tool
 *
 * Associate a connection with a project
 */

import { z } from "zod";
import { defineTool } from "../../core/define-tool";
import { requireAuth, requireOrganization } from "../../core/mesh-context";

export const PROJECT_CONNECTION_ADD = defineTool({
  name: "PROJECT_CONNECTION_ADD" as const,
  description:
    "Add an existing connection to a project, making its tools available in that project scope.",
  annotations: {
    title: "Add Project Connection",
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  inputSchema: z.object({
    projectId: z.string().describe("Project ID"),
    connectionId: z.string().describe("Connection ID to associate"),
  }),

  outputSchema: z.object({
    success: z.boolean(),
    projectConnectionId: z.string(),
  }),

  handler: async (input, ctx) => {
    requireAuth(ctx);
    const organization = requireOrganization(ctx);
    await ctx.access.check();

    const { projectId, connectionId } = input;

    // Validate project exists and belongs to the caller's org
    const project = await ctx.storage.projects.get(projectId);
    if (!project || project.organizationId !== organization.id) {
      throw new Error(`Project not found: ${projectId}`);
    }

    // Validate connection exists and belongs to the same org
    const connection = await ctx.storage.connections.findById(connectionId);
    if (!connection || connection.organization_id !== organization.id) {
      throw new Error(`Connection not found: ${connectionId}`);
    }

    const pc = await ctx.storage.projectConnections.add(
      projectId,
      connectionId,
    );

    return {
      success: true,
      projectConnectionId: pc.id,
    };
  },
});
