/**
 * PROJECT_PLUGIN_CONFIG_UPDATE Tool
 *
 * Update or create plugin configuration for a project
 */

import { z } from "zod";
import { defineTool } from "../../core/define-tool";
import { getUserId, requireAuth } from "../../core/mesh-context";
import { serializedPluginConfigSchema } from "./schema";
import {
  createDevAssetsConnectionEntity,
  isDevAssetsConnection,
  isDevMode,
} from "../connection/dev-assets";
import { getBaseUrl } from "../../core/server-constants";

export const PROJECT_PLUGIN_CONFIG_UPDATE = defineTool({
  name: "PROJECT_PLUGIN_CONFIG_UPDATE" as const,
  description: "Set or update a plugin's configuration for a specific project.",
  annotations: {
    title: "Update Project Plugin Config",
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: true,
    openWorldHint: false,
  },
  inputSchema: z.object({
    projectId: z.string().describe("Project ID"),
    pluginId: z.string().describe("Plugin ID"),
    connectionId: z
      .string()
      .nullable()
      .optional()
      .describe("MCP connection to bind"),
    settings: z
      .record(z.string(), z.unknown())
      .nullable()
      .optional()
      .describe("Plugin-specific settings"),
  }),

  outputSchema: z.object({
    config: serializedPluginConfigSchema,
  }),

  handler: async (input, ctx) => {
    // Require authentication
    requireAuth(ctx);

    // Check authorization
    await ctx.access.check();

    const { projectId, pluginId, connectionId, settings } = input;
    const userId = getUserId(ctx);

    const project = await ctx.storage.projects.get(projectId);
    if (!project) {
      throw new Error(`Project not found: ${projectId}`);
    }

    const connectionExists = connectionId
      ? await ctx.storage.connections.findById(connectionId)
      : null;

    if (
      connectionId &&
      project.organizationId &&
      !connectionExists &&
      isDevMode()
    ) {
      if (isDevAssetsConnection(connectionId, project.organizationId)) {
        if (!userId) {
          throw new Error("User ID required to create dev-assets connection");
        }
        const devAssetsConnection = createDevAssetsConnectionEntity(
          project.organizationId,
          getBaseUrl(),
        );
        await ctx.storage.connections.create({
          ...devAssetsConnection,
          organization_id: project.organizationId,
          created_by: userId,
        });
      }
    }

    const config = await ctx.storage.projectPluginConfigs.upsert(
      projectId,
      pluginId,
      {
        connectionId,
        settings,
      },
    );

    return {
      config: {
        id: config.id,
        projectId: config.projectId,
        pluginId: config.pluginId,
        connectionId: config.connectionId,
        settings: config.settings,
        createdAt:
          config.createdAt instanceof Date
            ? config.createdAt.toISOString()
            : config.createdAt,
        updatedAt:
          config.updatedAt instanceof Date
            ? config.updatedAt.toISOString()
            : config.updatedAt,
      },
    };
  },
});
