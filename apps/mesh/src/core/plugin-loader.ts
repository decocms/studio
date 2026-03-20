/**
 * Server Plugin Loader
 *
 * Loads and initializes server plugins, providing:
 * - Tool registration with org-enabled gating
 * - Route mounting
 * - Migration collection
 * - Storage factory initialization
 * - Event handler registration and routing
 */

import type { Hono } from "hono";
import type {
  ServerPluginContext,
  ServerPluginMigration,
  ServerPluginEvent,
  ServerPluginEventContext,
  ServerPluginStartupContext,
} from "@decocms/bindings/server-plugin";
import type { z } from "zod";
import { WellKnownOrgMCPId } from "@decocms/mesh-sdk";
import { serverPlugins } from "../server-plugins";
import type { MeshContext } from "./mesh-context";
import type { Tool, ToolDefinition } from "./define-tool";
import type { CredentialVault } from "../encryption/credential-vault";
import type { CloudEvent } from "@decocms/bindings";

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
  ctx: MeshContext,
  orgId: string,
  pluginId: string,
): Promise<boolean> {
  // Check legacy org settings
  const settings = await ctx.storage.organizationSettings.get(orgId);
  if (settings?.enabled_plugins?.includes(pluginId)) {
    return true;
  }

  // Check all virtual MCPs in the org
  const virtualMcps = await ctx.storage.virtualMcps.list(orgId);
  for (const virtualMcp of virtualMcps) {
    const enabledPlugins = virtualMcp.metadata?.enabled_plugins;
    if (Array.isArray(enabledPlugins) && enabledPlugins.includes(pluginId)) {
      return true;
    }
  }

  return false;
}

/**
 * Ensure plugin event subscriptions are synced for the given org.
 * Called lazily on first plugin tool invocation per-org.
 * Awaited to ensure subscriptions exist before the tool publishes events.
 * Subsequent calls for the same org are no-ops (cached).
 */
async function ensureSubscriptionsForOrg(
  ctx: MeshContext,
  orgId: string,
): Promise<void> {
  if (!hasPluginEventHandlers()) return;

  const existing = syncedOrgs.get(orgId);
  if (existing) {
    await existing;
    return;
  }

  const selfConnectionId = WellKnownOrgMCPId.SELF(orgId);
  const promise = ensurePluginEventSubscriptions(
    ctx.eventBus,
    orgId,
    selfConnectionId,
  );
  syncedOrgs.set(orgId, promise);
  await promise;
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

      // Ensure plugin event subscriptions exist for this org (lazy, cached after first call)
      await ensureSubscriptionsForOrg(ctx, org.id);

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

      // Ensure plugin event subscriptions exist for this org (lazy, cached after first call)
      await ensureSubscriptionsForOrg(ctx, org.id);

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
      // MeshContext is a superset of ServerPluginToolContext so the cast is safe.
      // MeshContext is a superset of ServerPluginToolContext; the Kysely
      // generic parameter differs (Database vs unknown) so we go through unknown.
      const handler = toolDef.handler as unknown as (
        input: unknown,
        ctx: MeshContext,
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

/**
 * Track which organizations have had plugin event subscriptions synced.
 * Uses a Map of in-flight promises to coalesce concurrent requests for the same org,
 * avoiding redundant syncSubscriptions calls from parallel tool invocations.
 * Once resolved, the promise stays cached so subsequent calls are instant no-ops.
 */
const syncedOrgs = new Map<string, Promise<void>>();

/**
 * Collect all event types that plugins want to handle.
 * Returns a flat array of event type strings.
 */
function collectPluginEventTypes(): string[] {
  const types: string[] = [];
  for (const plugin of serverPlugins) {
    if (plugin.onEvents) {
      types.push(...plugin.onEvents.types);
    }
  }
  return types;
}

/**
 * Ensure plugin event subscriptions exist for an organization.
 *
 * Creates subscriptions on the SELF connection for all plugin event types.
 * Uses syncSubscriptions for idempotency — safe to call multiple times.
 * Results are cached per-org so subsequent calls are no-ops.
 *
 * @param eventBus - Event bus instance
 * @param organizationId - Organization to sync subscriptions for
 * @param selfConnectionId - SELF connection ID (e.g., "org123_self")
 */
async function ensurePluginEventSubscriptions(
  eventBus: {
    syncSubscriptions: (
      orgId: string,
      input: {
        connectionId: string;
        subscriptions: Array<{
          eventType: string;
          publisher?: string;
        }>;
      },
    ) => Promise<unknown>;
  },
  organizationId: string,
  selfConnectionId: string,
): Promise<void> {
  const allEventTypes = collectPluginEventTypes();
  if (allEventTypes.length === 0) return;

  try {
    await eventBus.syncSubscriptions(organizationId, {
      connectionId: selfConnectionId,
      subscriptions: allEventTypes.map((eventType) => ({
        eventType,
        // Subscribe to events from any publisher (including SELF)
        publisher: undefined,
      })),
    });
  } catch (error) {
    // Remove from map so the next call can retry
    syncedOrgs.delete(organizationId);
    console.error(
      `[PluginLoader] Failed to sync plugin event subscriptions for org ${organizationId}:`,
      error,
    );
  }
}

/**
 * Check if any registered plugins handle events.
 */
export function hasPluginEventHandlers(): boolean {
  return serverPlugins.some((p) => p.onEvents);
}

/**
 * Route events to matching plugin handlers.
 *
 * Called by the event bus notify subscriber when events are delivered
 * to the SELF connection. Matches event types against plugin subscriptions
 * and dispatches to the appropriate handlers.
 *
 * @param events - CloudEvents to route
 * @param ctx - Event context with org info and publish function
 * @returns true if any plugin handled events, false otherwise
 */
export async function routeEventsToPlugins(
  events: CloudEvent[],
  ctx: ServerPluginEventContext,
): Promise<boolean> {
  let handled = false;

  for (const plugin of serverPlugins) {
    if (!plugin.onEvents) continue;

    // Filter events that match this plugin's registered types
    const matchingEvents = events.filter((event) =>
      plugin.onEvents!.types.some((type) => matchEventType(type, event.type)),
    );

    if (matchingEvents.length === 0) continue;

    // Convert CloudEvents to ServerPluginEvents
    const pluginEvents: ServerPluginEvent[] = matchingEvents.map((e) => ({
      id: e.id,
      type: e.type,
      source: e.source,
      subject: e.subject,
      data: e.data,
      time: e.time,
    }));

    try {
      await plugin.onEvents.handler(pluginEvents, ctx);
      handled = true;
    } catch (error) {
      console.error(
        `[PluginLoader] Plugin "${plugin.id}" event handler error:`,
        error,
      );
      // Don't throw - other plugins should still get their events
      handled = true; // Still counts as handled even if errored
    }
  }

  return handled;
}

/**
 * Match an event type against a pattern.
 * Supports exact match and wildcard suffix (e.g., "workflow.*" matches "workflow.execution.created").
 */
function matchEventType(pattern: string, eventType: string): boolean {
  if (pattern === eventType) return true;
  if (pattern.endsWith(".*")) {
    const prefix = pattern.slice(0, -2);
    return eventType.startsWith(prefix + ".");
  }
  return false;
}

// ============================================================================
// Plugin Startup Hooks
// ============================================================================

/**
 * Run onStartup hooks for all registered plugins.
 *
 * Called once after the event bus is ready and plugin storage is initialized.
 * Each plugin's onStartup is called independently — errors in one plugin
 * don't prevent other plugins from starting.
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
