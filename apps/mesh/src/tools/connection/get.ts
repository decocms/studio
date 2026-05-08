/**
 * COLLECTION_CONNECTIONS_GET Tool
 *
 * Get connection details by ID with collection binding compliance.
 */

import {
  CollectionGetInputSchema,
  createCollectionGetOutputSchema,
} from "@decocms/bindings/collections";
import { WellKnownOrgMCPId } from "@decocms/mesh-sdk";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { defineTool } from "../../core/define-tool";
import { requireOrganization } from "../../core/mesh-context";
import { getBaseUrl } from "../../core/server-constants";
import {
  getMcpListCache,
  fetchWithCache,
} from "../../mcp-clients/mcp-list-cache";
import { clientFromConnection } from "../../mcp-clients";
import {
  createDevAssetsConnectionEntity,
  isDevAssetsConnection,
  usesLocalObjectStorage,
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

    // Resolve the dev-assets pseudo-connection when local object storage is in use
    if (
      usesLocalObjectStorage() &&
      isDevAssetsConnection(input.id, organization.id)
    ) {
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

    if (connection.tools === null) {
      const selfId = WellKnownOrgMCPId.SELF(organization.id);
      const fetchLive =
        connection.id === selfId
          ? async () => {
              const { listManagementTools } = await import("../../tools");
              return listManagementTools(ctx) as Promise<unknown[]>;
            }
          : async () => {
              const client = await clientFromConnection(connection, ctx, true);
              try {
                const result = await client.listTools();
                return result.tools;
              } finally {
                await client.close().catch(() => {});
              }
            };
      const tools = await fetchWithCache(
        "tools",
        connection.id,
        fetchLive,
        getMcpListCache(),
        (p) => ctx.pendingRevalidations.push(p),
      );
      if (tools !== null) {
        connection.tools = tools as Tool[];
      }
    }

    return {
      item: connection,
    };
  },
});
