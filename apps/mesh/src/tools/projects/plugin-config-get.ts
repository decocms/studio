/**
 * PROJECT_PLUGIN_CONFIG_GET Tool
 *
 * Get plugin configuration for a project
 */

import { z } from "zod";
import { defineTool } from "../../core/define-tool";
import { requireAuth } from "../../core/mesh-context";
import { serializedPluginConfigSchema } from "./schema";

export const PROJECT_PLUGIN_CONFIG_GET = defineTool({
  name: "PROJECT_PLUGIN_CONFIG_GET" as const,
  description: "Get a plugin's current configuration for a specific project.",
  annotations: {
    title: "Get Project Plugin Config",
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  inputSchema: z.object({
    projectId: z.string().describe("Project ID"),
    pluginId: z.string().describe("Plugin ID"),
  }),

  outputSchema: z.object({
    config: serializedPluginConfigSchema.nullable(),
  }),

  handler: async (input, ctx) => {
    // Require authentication
    requireAuth(ctx);

    // Check authorization
    await ctx.access.check();

    const { projectId, pluginId } = input;

    const config = await ctx.storage.projectPluginConfigs.get(
      projectId,
      pluginId,
    );

    if (!config) {
      return { config: null };
    }

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
