/**
 * VIRTUAL_MCP_PLUGIN_CONFIG_UPDATE Tool
 *
 * Update or create plugin configuration for a virtual MCP
 */

import { z } from "zod";
import { defineTool } from "../../core/define-tool";
import { getUserId, requireAuth } from "../../core/mesh-context";
import {
  createDevAssetsConnectionEntity,
  isDevAssetsConnection,
  isDevMode,
} from "../connection/dev-assets";
import { getBaseUrl } from "../../core/server-constants";

const serializedPluginConfigSchema = z.object({
  id: z.string(),
  virtualMcpId: z.string(),
  pluginId: z.string(),
  connectionId: z.string().nullable(),
  settings: z.record(z.string(), z.unknown()).nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export const VIRTUAL_MCP_PLUGIN_CONFIG_UPDATE = defineTool({
  name: "VIRTUAL_MCP_PLUGIN_CONFIG_UPDATE" as const,
  description:
    "Set or update a plugin's configuration for a specific virtual MCP.",
  annotations: {
    title: "Update Virtual MCP Plugin Config",
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: true,
    openWorldHint: false,
  },
  inputSchema: z.object({
    virtualMcpId: z.string().describe("Virtual MCP ID"),
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

    const { virtualMcpId, pluginId, connectionId, settings } = input;
    const userId = getUserId(ctx);

    const virtualMcp = await ctx.storage.virtualMcps.findById(virtualMcpId);
    if (!virtualMcp) {
      throw new Error(`Virtual MCP not found: ${virtualMcpId}`);
    }

    const connectionExists = connectionId
      ? await ctx.storage.connections.findById(connectionId)
      : null;

    if (
      connectionId &&
      virtualMcp.organization_id &&
      !connectionExists &&
      isDevMode()
    ) {
      if (isDevAssetsConnection(connectionId, virtualMcp.organization_id)) {
        if (!userId) {
          throw new Error("User ID required to create dev-assets connection");
        }
        const devAssetsConnection = createDevAssetsConnectionEntity(
          virtualMcp.organization_id,
          getBaseUrl(),
        );
        await ctx.storage.connections.create({
          ...devAssetsConnection,
          organization_id: virtualMcp.organization_id,
          created_by: userId,
        });
      }
    }

    const config = await ctx.storage.virtualMcpPluginConfigs.upsert(
      virtualMcpId,
      pluginId,
      {
        connectionId,
        settings,
      },
    );

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
