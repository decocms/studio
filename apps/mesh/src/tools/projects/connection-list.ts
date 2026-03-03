/**
 * PROJECT_CONNECTION_LIST Tool
 *
 * List connections associated with a project
 */

import { z } from "zod";
import { defineTool } from "../../core/define-tool";
import { requireAuth, requireOrganization } from "../../core/mesh-context";

const connectionSummarySchema = z.object({
  id: z.string(),
  title: z.string(),
  icon: z.string().nullable(),
  connectionType: z.string(),
  status: z.string(),
});

export const PROJECT_CONNECTION_LIST = defineTool({
  name: "PROJECT_CONNECTION_LIST" as const,
  description: "List connections associated with a project",
  annotations: {
    title: "List Project Connections",
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  inputSchema: z.object({
    projectId: z.string().describe("Project ID"),
  }),

  outputSchema: z.object({
    connections: z.array(connectionSummarySchema),
  }),

  handler: async (input, ctx) => {
    requireAuth(ctx);
    const organization = requireOrganization(ctx);
    await ctx.access.check();

    const { projectId } = input;

    const project = await ctx.storage.projects.get(projectId);
    if (!project || project.organizationId !== organization.id) {
      throw new Error(`Project not found: ${projectId}`);
    }

    const projectConnections =
      await ctx.storage.projectConnections.list(projectId);

    const results = await Promise.all(
      projectConnections.map((pc) =>
        ctx.storage.connections.findById(pc.connectionId),
      ),
    );
    const connections = results
      .filter((conn) => conn != null)
      .map((conn) => ({
        id: conn.id,
        title: conn.title,
        icon: conn.icon ?? null,
        connectionType: conn.connection_type,
        status: conn.status,
      }));

    return { connections };
  },
});
