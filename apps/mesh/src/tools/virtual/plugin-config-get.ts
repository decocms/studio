/**
 * VIRTUAL_MCP_PLUGIN_CONFIG_GET Tool
 *
 * Get plugin configuration for a virtual MCP
 */

import { z } from "zod";
import { defineTool } from "../../core/define-tool";
import { requireAuth } from "../../core/mesh-context";

const serializedPluginConfigSchema = z.object({
  id: z.string(),
  virtualMcpId: z.string(),
  pluginId: z.string(),
  connectionId: z.string().nullable(),
  settings: z.record(z.string(), z.unknown()).nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export const VIRTUAL_MCP_PLUGIN_CONFIG_GET = defineTool({
  name: "VIRTUAL_MCP_PLUGIN_CONFIG_GET" as const,
  description:
    "Get a plugin's current configuration for a specific virtual MCP.",
  annotations: {
    title: "Get Virtual MCP Plugin Config",
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  inputSchema: z.object({
    virtualMcpId: z.string().describe("Virtual MCP ID"),
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

    const { virtualMcpId, pluginId } = input;

    const config = await ctx.storage.virtualMcpPluginConfigs.get(
      virtualMcpId,
      pluginId,
    );

    if (!config) {
      return { config: null };
    }

    return {
      config: {
        id: config.id,
        virtualMcpId: config.virtualMcpId,
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
