/**
 * COLLECTION_CONNECTIONS_DELETE Tool
 *
 * Delete a connection with collection binding compliance.
 */

import {
  CollectionDeleteInputSchema,
  createCollectionDeleteOutputSchema,
} from "@decocms/bindings/collections";
import { z } from "zod";
import { posthog } from "../../posthog";
import { defineTool } from "../../core/define-tool";
import {
  getUserId,
  requireAuth,
  requireOrganization,
} from "../../core/mesh-context";
import { getMcpListCache } from "../../mcp-clients/mcp-list-cache";
import { ConnectionEntitySchema } from "./schema";

const ConnectionDeleteInputSchema = CollectionDeleteInputSchema.extend({
  force: z
    .boolean()
    .optional()
    .describe(
      "If true, removes this connection from all agents that reference it before deleting",
    ),
});

export const COLLECTION_CONNECTIONS_DELETE = defineTool({
  name: "COLLECTION_CONNECTIONS_DELETE",
  description:
    "Permanently delete a connection. Set force=true to auto-remove from referencing Virtual MCPs.",
  annotations: {
    title: "Delete Connection",
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: true,
    openWorldHint: false,
  },
  inputSchema: ConnectionDeleteInputSchema,
  outputSchema: createCollectionDeleteOutputSchema(ConnectionEntitySchema),

  handler: async (input, ctx) => {
    // Require authentication
    requireAuth(ctx);

    // Require organization context
    const organization = requireOrganization(ctx);

    // Check authorization
    await ctx.access.check();

    // Fetch connection before deleting to return the entity
    const connection = await ctx.storage.connections.findById(input.id);
    if (!connection) {
      throw new Error(`Connection not found: ${input.id}`);
    }

    // Verify it belongs to the current organization
    if (connection.organization_id !== organization.id) {
      throw new Error("Connection not found in organization");
    }

    // Block deletion of fixed system connections (e.g., dev-assets in dev mode)
    const metadata = connection.metadata as Record<string, unknown> | null;
    if (metadata?.isFixed === true) {
      throw new Error(
        "This connection is a fixed system connection and cannot be deleted",
      );
    }

    // Check if connection is used by any Virtual MCPs (FK RESTRICT would block deletion)
    const referencingVirtualMcps =
      await ctx.storage.virtualMcps.listByConnectionId(
        organization.id,
        input.id,
      );
    if (referencingVirtualMcps.length > 0) {
      if (input.force) {
        // Force mode: remove all references to this connection from virtual MCPs
        await ctx.storage.virtualMcps.removeConnectionReferences(input.id);
      } else {
        throw new Error(
          JSON.stringify({
            code: "CONNECTION_IN_USE",
            agentNames: referencingVirtualMcps.map((v) => v.title),
          }),
        );
      }
    }

    // Cascade trigger subscriptions on the MCP side BEFORE deleting the
    // connection. Once the connection row is gone we can no longer build
    // an MCP client for it (configureTriggerOnMcp short-circuits on a
    // missing connection), so the disable signal would never reach the
    // MCP and its KV would accumulate orphaned trigger state.
    //
    // Imported dynamically to avoid a module evaluation cycle between
    // tools/index.ts and tools/automations/configure-trigger.ts.
    const boundTriggers = await ctx.storage.automations.listTriggersByConnection(
      input.id,
      organization.id,
    );
    const eventTriggers = boundTriggers.filter((t) => t.type === "event");
    if (eventTriggers.length > 0) {
      const { configureTriggerOnMcp } = await import(
        "../automations/configure-trigger"
      );
      await Promise.allSettled(
        eventTriggers.map(async (trigger) => {
          const result = await configureTriggerOnMcp(
            ctx,
            trigger,
            false,
            ctx.storage.triggerCallbackTokens,
          );
          if (!result.success) {
            console.warn(
              `[connection/delete] Failed to disable trigger ${trigger.id} on MCP: ${result.error}`,
            );
          }
        }),
      );
    }

    // Delete connection
    await ctx.storage.connections.delete(input.id);

    // Cleanup registry_config references to the deleted connection
    const orgSettings = await ctx.storage.organizationSettings.get(
      organization.id,
    );
    if (orgSettings?.registry_config) {
      const { registries, blockedMcps } = orgSettings.registry_config;
      if (input.id in registries) {
        const { [input.id]: _, ...rest } = registries;
        await ctx.storage.organizationSettings.upsert(organization.id, {
          registry_config: { registries: rest, blockedMcps },
        });
      }
    }

    // Invalidate NATS KV cache
    getMcpListCache()
      ?.invalidate(input.id)
      .catch(() => {});

    const userId = getUserId(ctx);
    if (userId) {
      posthog.capture({
        distinctId: userId,
        event: "connection_deleted",
        groups: { organization: organization.id },
        properties: {
          connection_id: connection.id,
          connection_type: connection.connection_type,
          app_name: connection.app_name ?? null,
          organization_id: organization.id,
          forced: input.force ?? false,
        },
      });
    }

    return {
      item: connection,
    };
  },
});
