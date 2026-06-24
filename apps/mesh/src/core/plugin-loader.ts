/**
 * Server Plugin Loader
 *
 * Loads and initializes server plugins, providing:
 * - Tool registration with org-enabled gating
 * - Route mounting
 * - Migration collection
 * - Storage factory initialization
 */

import type { Hono } from "hono";
import type {
  ServerPluginContext,
  ServerPluginMigration,
  ServerPluginStartupContext,
} from "@decocms/bindings/server-plugin";
import type { z } from "zod";
import { serverPlugins } from "../server-plugins";
import type { StudioContext } from "./studio-context";
import type { Tool, ToolDefinition } from "./define-tool";
import type { CredentialVault } from "../encryption/credential-vault";

// ============================================================================
// Plugin Tool Gating
// ============================================================================

/**
 * Map of tool name to plugin ID for filtering
 */
const pluginToolMap = new Map<string, string>();

/**
 * Check if a plugin is enabled for an organization.
 * Checks both org settings (legacy) and all virtual MCPs.
 */
async function isPluginEnabledForOrg(
  ctx: StudioContext,
  orgId: string,
  pluginId: string,
): Promise<boolean> {
  // Check legacy org settings
  const settings = await ctx.storage.organizationSettings.get(orgId);
  if (settings?.enabled_plugins?.includes(pluginId)) {
    return true;
  }

  // Check all virtual MCPs in the org
  const virtualMcpPlugins =
    await ctx.storage.virtualMcps.listEnabledPlugins(orgId);
  return virtualMcpPlugins.includes(pluginId);
}

function withPluginEnabled<
  TInput extends z.ZodType,
  TOutput extends z.ZodType,
  TName extends string,
>(
  pluginId: string,
  tool: Tool<TInput, TOutput, TName>,
): Tool<TInput, TOutput, TName> {
  // Track which plugin owns this tool
  pluginToolMap.set(tool.name, pluginId);

  return {
    ...tool,
    handler: async (input, ctx) => {
      const org = ctx.organization;
      if (!org) {
        throw new Error(
          `Organization context required for plugin tool "${tool.name}"`,
        );
      }

      if (!(await isPluginEnabledForOrg(ctx, org.id, pluginId))) {
        throw new Error(
          `Plugin "${pluginId}" is not enabled for this organization. ` +
            `Enable it in Settings > Plugins.`,
        );
      }

      return tool.handler(input, ctx);
    },
    execute: async (input, ctx) => {
      const org = ctx.organization;
      if (!org) {
        throw new Error(
          `Organization context required for plugin tool "${tool.name}"`,
        );
      }

      if (!(await isPluginEnabledForOrg(ctx, org.id, pluginId))) {
        throw new Error(
          `Plugin "${pluginId}" is not enabled for this organization. ` +
            `Enable it in Settings > Plugins.`,
        );
      }

      return tool.execute(input, ctx);
    },
  };
}

/**
 * Filter tools list based on enabled plugins for an organization.
 * Core tools (not from plugins) are always included.
 */
export function filterToolsByEnabledPlugins<T extends { name: string }>(
  tools: T[],
  enabledPlugins: string[] | null,
): T[] {
  return tools.filter((tool) => {
    const pluginId = pluginToolMap.get(tool.name);
    // Core tool (not from a plugin) - always show
    if (!pluginId) return true;
    // If org-level plugin settings are not configured, keep plugin tools visible.
    if (enabledPlugins == null) return true;
    // Plugin tool - only show if plugin is explicitly enabled
    return enabledPlugins.includes(pluginId);
  });
}

// ============================================================================
// Plugin Tool Collection
// ============================================================================

/**
 * Collect all tools from registered plugins, wrapped with org-enabled gating.
 * Call this at startup to integrate plugin tools with ALL_TOOLS.
 */
export function collectPluginTools(): ToolDefinition<
  z.ZodType,
  z.ZodType,
  string
>[] {
  const tools: ToolDefinition<z.ZodType, z.ZodType, string>[] = [];

  for (const plugin of serverPlugins) {
    if (!plugin.tools) continue;

    for (const toolDef of plugin.tools) {
      // Convert ServerPluginToolDefinition to Tool and wrap with gating.
      // StudioContext is a superset of ServerPluginToolContext so the cast is safe.
      // StudioContext is a superset of ServerPluginToolContext; the Kysely
      // generic parameter differs (Database vs unknown) so we go through unknown.
      const handler = toolDef.handler as unknown as (
        input: unknown,
        ctx: StudioContext,
      ) => Promise<unknown>;
      const tool = {
        name: toolDef.name,
        description: toolDef.description ?? "",
        inputSchema: toolDef.inputSchema as z.ZodType,
        outputSchema: toolDef.outputSchema as z.ZodType | undefined,
        handler,
        execute: handler,
      } as Tool<z.ZodType, z.ZodType, string>;

      const wrappedTool = withPluginEnabled(plugin.id, tool);
      tools.push(wrappedTool);
    }
  }

  return tools;
}

// ============================================================================
// Plugin Route Mounting
// ============================================================================

/**
 * Mount all plugin routes onto the Hono app.
 * - Authenticated routes at /api/plugins/:pluginId/*
 * - Public routes at root level
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function mountPluginRoutes(
  app: Hono<any>,
  ctx: ServerPluginContext,
): void {
  for (const plugin of serverPlugins) {
    // Mount authenticated routes under /api/plugins/:pluginId
    if (plugin.routes) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const pluginApp = new (app.constructor as new () => Hono<any>)();
      plugin.routes(pluginApp, ctx);
      app.route(`/api/plugins/${plugin.id}`, pluginApp);
    }

    // Mount public routes at root level
    if (plugin.publicRoutes) {
      plugin.publicRoutes(app, ctx);
    }
  }
}

// ============================================================================
// Plugin Migration Collection
// ============================================================================

/**
 * Collect all migrations from registered plugins.
 * Returns migrations prefixed with plugin ID for ordering.
 */
export function collectPluginMigrations(): Array<{
  pluginId: string;
  migration: ServerPluginMigration;
}> {
  const migrations: Array<{
    pluginId: string;
    migration: ServerPluginMigration;
  }> = [];

  for (const plugin of serverPlugins) {
    if (!plugin.migrations) continue;

    for (const migration of plugin.migrations) {
      migrations.push({
        pluginId: plugin.id,
        migration,
      });
    }
  }

  // Sort by migration name to ensure consistent ordering
  migrations.sort((a, b) => a.migration.name.localeCompare(b.migration.name));

  return migrations;
}

// ============================================================================
// Plugin Storage Initialization
// ============================================================================

/**
 * Storage instances created by plugins
 */
const pluginStorageMap = new Map<string, unknown>();

/**
 * Initialize all plugin storage factories.
 * Call this during context factory initialization.
 */
export function initializePluginStorage(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: any,
  vault: CredentialVault,
): void {
  // Create context with proper vault interface
  // db is typed as `any` to avoid Kysely version mismatch issues between packages
  const ctx: ServerPluginContext = {
    db,
    vault: {
      encrypt: (value: string) => vault.encrypt(value),
      decrypt: (value: string) => vault.decrypt(value),
    },
  };

  for (const plugin of serverPlugins) {
    if (plugin.createStorage) {
      const storage = plugin.createStorage(ctx);
      pluginStorageMap.set(plugin.id, storage);
    }
  }
}

// ============================================================================
// Plugin Event Handling
// ============================================================================

// ============================================================================
// Plugin Startup Hooks
// ============================================================================

/**
 * Run onStartup hooks for all registered plugins.
 *
 * Called once after plugin storage is initialized. Each plugin's onStartup is
 * called independently — errors in one plugin don't prevent other plugins from
 * starting.
 */
export async function runPluginStartupHooks(
  ctx: ServerPluginStartupContext,
): Promise<void> {
  for (const plugin of serverPlugins) {
    if (!plugin.onStartup) continue;

    try {
      await plugin.onStartup(ctx);
    } catch (error) {
      console.error(
        `[PluginLoader] Plugin "${plugin.id}" onStartup hook failed:`,
        error,
      );
    }
  }
}
