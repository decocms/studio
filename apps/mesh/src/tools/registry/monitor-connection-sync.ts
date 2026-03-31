import { defineTool } from "@/core/define-tool";
import { requireOrganization } from "@/core/mesh-context";
import {
  RegistryMonitorConnectionSyncInputSchema,
  RegistryMonitorConnectionSyncOutputSchema,
} from "./monitor-schemas";
import { ensureMonitorConnection } from "./monitor-run-start";

import { PUBLISH_REQUEST_TARGET_PREFIX } from "./shared";
import type {
  PrivateRegistryItemEntity,
  PublishRequestEntity,
} from "@/storage/registry";

function requestToMonitorTarget(
  request: PublishRequestEntity,
): PrivateRegistryItemEntity {
  return {
    id: `${PUBLISH_REQUEST_TARGET_PREFIX}${request.id}`,
    title: request.title,
    description: request.description,
    _meta: request._meta,
    server: request.server,
    is_public: false,
    is_unlisted: true,
    created_at: request.created_at,
    updated_at: request.updated_at,
  };
}

export const REGISTRY_MONITOR_CONNECTION_SYNC = defineTool({
  name: "REGISTRY_MONITOR_CONNECTION_SYNC" as const,
  description:
    "Ensure every registry item has a dedicated monitor connection mapping for MCP monitors",
  inputSchema: RegistryMonitorConnectionSyncInputSchema,
  outputSchema: RegistryMonitorConnectionSyncOutputSchema,
  handler: async (_input, ctx) => {
    const organization = requireOrganization(ctx);
    await ctx.access.check();
    const storage = ctx.storage.registry;
    const storeItems = (
      await storage.items.list(organization.id, { includeUnlisted: true })
    ).items;
    const pendingRequests = (
      await storage.publishRequests.list(organization.id, {
        status: "pending",
        limit: 500,
      })
    ).items;
    const requestItems = pendingRequests.map(requestToMonitorTarget);
    const targets = [...storeItems, ...requestItems];
    const before = await storage.monitorConnections.list(organization.id);
    const existingByItem = new Set(before.map((m) => m.item_id));

    let created = 0;
    for (const item of targets) {
      if (!item.server.remotes?.some((r) => r.url)) continue;
      await ensureMonitorConnection(
        ctx as Parameters<typeof ensureMonitorConnection>[0],
        item,
      );
      if (!existingByItem.has(item.id)) created += 1;
    }

    return {
      created,
      updated: Math.max(targets.length - created, 0),
    };
  },
});
