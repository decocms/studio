import { defineTool } from "@/core/define-tool";
import { requireOrganization } from "@/core/mesh-context";
import type { z } from "zod";
import {
  RegistryMonitorConnectionListInputSchema,
  RegistryMonitorConnectionListOutputSchema,
} from "./monitor-schemas";

import { PUBLISH_REQUEST_TARGET_PREFIX } from "./shared";

export const REGISTRY_MONITOR_CONNECTION_LIST = defineTool({
  name: "REGISTRY_MONITOR_CONNECTION_LIST" as const,
  description:
    "List monitor connection mappings for private registry MCP monitor runs, including auth status",
  inputSchema: RegistryMonitorConnectionListInputSchema,
  outputSchema: RegistryMonitorConnectionListOutputSchema,
  handler: async (_input, ctx) => {
    const organization = requireOrganization(ctx);
    await ctx.access.check();
    const storage = ctx.storage.registry;
    const mappings = await storage.monitorConnections.list(organization.id);
    const items = await Promise.all(
      mappings.map(async (mapping) => {
        let item = await storage.items.findById(
          organization.id,
          mapping.item_id,
        );
        if (
          !item &&
          mapping.item_id.startsWith(PUBLISH_REQUEST_TARGET_PREFIX)
        ) {
          const requestId = mapping.item_id.slice(
            PUBLISH_REQUEST_TARGET_PREFIX.length,
          );
          const request = await storage.publishRequests.findById(
            organization.id,
            requestId,
          );
          if (request) {
            item = {
              id: mapping.item_id,
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
        }
        const remoteUrl = item?.server.remotes?.find((r) => r.url)?.url ?? null;
        const source: "store" | "request" = mapping.item_id.startsWith(
          PUBLISH_REQUEST_TARGET_PREFIX,
        )
          ? "request"
          : "store";
        return {
          mapping,
          item,
          remoteUrl,
          source,
        };
      }),
    );
    return { items } as z.infer<
      typeof RegistryMonitorConnectionListOutputSchema
    >;
  },
});
