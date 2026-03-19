/**
 * COLLECTION_CONNECTIONS_GET Tool
 *
 * Get connection details by ID with collection binding compliance.
 */

import {
  CollectionGetInputSchema,
  createCollectionGetOutputSchema,
} from "@decocms/bindings/collections";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { defineTool } from "../../core/define-tool";
import { requireOrganization } from "../../core/mesh-context";
import { getBaseUrl } from "../../core/server-constants";
import { getMcpListCache } from "../../mcp-clients/mcp-list-cache";
import { clientFromConnection } from "../../mcp-clients";
import {
  createDevAssetsConnectionEntity,
  isDevAssetsConnection,
  isDevMode,
} from "./dev-assets";
import { ConnectionEntitySchema } from "./schema";

/**
 * Output schema using the ConnectionEntitySchema
 */
const ConnectionGetOutputSchema = createCollectionGetOutputSchema(
  ConnectionEntitySchema,
);

export const COLLECTION_CONNECTIONS_GET = defineTool({
  name: "COLLECTION_CONNECTIONS_GET",
  description:
    "Get a connection's configuration, tools list, and status by ID.",
  annotations: {
    title: "Get Connection",
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  _meta: { ui: { visibility: ["app"] } },
  inputSchema: CollectionGetInputSchema,
  outputSchema: ConnectionGetOutputSchema,

  handler: async (input, ctx) => {
    // Require organization context
    const organization = requireOrganization(ctx);

    // Check authorization
    await ctx.access.check();

    // In dev mode, check if this is the dev-assets connection
    if (isDevMode() && isDevAssetsConnection(input.id, organization.id)) {
      return {
        item: createDevAssetsConnectionEntity(organization.id, getBaseUrl()),
      };
    }

    // Get connection from database
    const connection = await ctx.storage.connections.findById(input.id);

    // Verify connection exists and belongs to the current organization
    if (!connection || connection.organization_id !== organization.id) {
      return { item: null };
    }

    // Hydrate tools from NATS KV cache, falling back to live MCP fetch
    if (connection.tools === null) {
      const cache = getMcpListCache();

      if (cache) {
        const cached = await cache.get("tools", connection.id);
        if (cached !== null) {
          connection.tools = cached as Tool[];
        }
      }

      if (connection.tools === null) {
        try {
          const client = await clientFromConnection(connection, ctx, true);
          try {
            const result = await client.listTools();
            connection.tools = result.tools as Tool[];
            cache?.set("tools", connection.id, result.tools).catch(() => {});
          } finally {
            await client.close().catch(() => {});
          }
        } catch {
          // Connection unreachable — leave tools as null
        }
      }
    }

    return {
      item: connection,
    };
  },
});
