/**
 * Event Bus Notification Module
 *
 * Handles notifying subscriber connections of events using the MCP proxy
 * and the Event Receiver binding.
 *
 * For server plugins: Events destined for the SELF connection are intercepted
 * and routed to plugin event handlers (if any match) before falling through
 * to the standard MCP proxy path.
 */

import { ContextFactory } from "@/core/context-factory";
import {
  hasPluginEventHandlers,
  routeEventsToPlugins,
} from "@/core/plugin-loader";
import { EventSubscriberBinding } from "@decocms/bindings";
import type { ServerPluginEventContext } from "@decocms/bindings/server-plugin";
import {
  dangerouslyCreateSuperUserMCPProxy,
  toServerClient,
} from "../api/routes/proxy";
import type { NotifySubscriberFn } from "./interface";

/**
 * Check if a connection ID is a SELF MCP connection.
 * SELF connections have the format: `{orgId}_self`
 */
function isSelfConnection(connectionId: string): boolean {
  return connectionId.endsWith("_self");
}

/**
 * Extract organization ID from a SELF connection ID.
 * E.g., "org123_self" → "org123"
 */
function orgIdFromSelfConnection(connectionId: string): string {
  return connectionId.slice(0, -"_self".length);
}

/**
 * Create a notify subscriber function that uses MCP proxy
 *
 * This function creates the callback used by the event bus worker
 * to deliver events to subscriber connections via the ON_EVENTS tool.
 *
 * For SELF connections, events are first routed to server plugin handlers.
 * If any plugin handles the events, they are considered delivered.
 * Otherwise, the standard MCP proxy path is used.
 *
 * @returns NotifySubscriberFn callback
 */
export function createNotifySubscriber(): NotifySubscriberFn {
  return async (connectionId, events) => {
    try {
      // Check if this is a SELF connection and plugins have event handlers
      if (isSelfConnection(connectionId) && hasPluginEventHandlers()) {
        const orgId = orgIdFromSelfConnection(connectionId);
        const ctx = await ContextFactory.create();

        // Build the plugin event context
        const pluginCtx: ServerPluginEventContext = {
          organizationId: orgId,
          connectionId,
          publish: async (type, subject, data, options) => {
            await ctx.eventBus.publish(orgId, connectionId, {
              type,
              subject,
              data,
              deliverAt: options?.deliverAt,
            });
          },
          createMCPProxy: async (targetConnectionId: string) => {
            // Use super-user proxy since this runs in a background worker context
            const proxy = await dangerouslyCreateSuperUserMCPProxy(
              targetConnectionId,
              ctx,
            );
            // Wrap to match the simplified ServerPluginEventContext interface
            return {
              callTool: async (
                params: {
                  name: string;
                  arguments?: Record<string, unknown> | undefined;
                },
                resultSchema?: unknown,
                options?: { timeout?: number | undefined } | undefined,
              ) => {
                const result = await proxy.callTool(
                  params,
                  resultSchema as Parameters<typeof proxy.callTool>[1],
                  options,
                );
                return {
                  content: result.content,
                  structuredContent: result.structuredContent,
                  isError: result.isError as boolean | undefined,
                };
              },
              close: () => proxy.close(),
            };
          },
        };

        // Route to plugin handlers
        const handled = await routeEventsToPlugins(events, pluginCtx);
        if (handled) {
          return { success: true };
        }
      }

      // Standard path: deliver via MCP proxy ON_EVENTS
      const ctx = await ContextFactory.create();

      // Create MCP proxy for the subscriber connection
      const proxy = await dangerouslyCreateSuperUserMCPProxy(connectionId, ctx);

      // Use the Event Subscriber binding - pass the whole proxy object
      // Same pattern as LanguageModelBinding.forClient(proxy) in models.ts
      const client = EventSubscriberBinding.forClient(toServerClient(proxy));

      // Call ON_EVENTS with the batch of events
      const result = await client.ON_EVENTS({ events });

      return {
        success: result.success,
        error: result.error,
        retryAfter: result.retryAfter,
        results: result.results,
      };
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);

      console.error(
        `[EventBus] Failed to notify connection ${connectionId}:`,
        errorMessage,
      );

      return {
        success: false,
        error: errorMessage,
      };
    }
  };
}
