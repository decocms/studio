/**
 * VIRTUAL_MCP_PLUGIN_CONFIG_GET Tool
 *
 * Get plugin configuration for a virtual MCP
 */

import { z } from "zod";
import { defineTool } from "../../core/define-tool";
import { requireAuth, requireOrganization } from "../../core/studio-context";

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
    const organization = requireOrganization(ctx);

    // Check authorization
    await ctx.access.check();

    const { virtualMcpId, pluginId } = input;

    // `ctx.access.check()` only verifies the caller's permissions in
    // `ctx.organization` — it doesn't know `virtualMcpId` belongs to it, so a
    // caller could otherwise read another org's plugin config by ID.
    const parentConnection =
      await ctx.storage.connections.findById(virtualMcpId);
    if (
      !parentConnection ||
      parentConnection.organization_id !== organization.id
    ) {
      return { config: null };
    }
    // This tool only manages plugin config for virtual MCPs — a plugin
    // config row keyed by a non-virtual connection can only exist as leftover
    // data from before VIRTUAL_MCP_PLUGIN_CONFIG_UPDATE started rejecting
    // non-virtual connections (see plugin-config-update.ts), so don't surface it.
    if (parentConnection.connection_type !== "VIRTUAL") {
      return { config: null };
    }

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
