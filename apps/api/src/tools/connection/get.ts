/**
 * COLLECTION_CONNECTIONS_GET Tool
 *
 * Get connection details by ID with collection binding compliance.
 */

import { isValidUrlSlug } from "@decocms/shared/url-slug";
import {
  CollectionGetInputSchema,
  createCollectionGetOutputSchema,
} from "@decocms/bindings/collections";
import { WellKnownOrgMCPId } from "@decocms/shared/sdk";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { defineTool } from "../../core/define-tool";
import { requireOrganization } from "../../core/studio-context";
import { getBaseUrl } from "../../core/server-constants";
import {
  getMcpListCache,
  fetchWithCache,
  REVALIDATE_MIN_INTERVAL_MS,
} from "../../mcp-clients/mcp-list-cache";
import { listToolsWithTimeout } from "../../mcp-clients";
import { MCP_LIST_TOOLS_TIMEOUT_MS } from "../../core/constants";
import {
  createDevAssetsConnectionEntity,
  isDevAssetsConnection,
  usesLocalObjectStorage,
} from "./dev-assets";
import { redactConnectionToken } from "./redact";
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
    "Get a connection's configuration, tools list, and status by ID or URL slug.",
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

    // A link names the connection by its URL slug; slugs can't contain `_`, so ids never take that path.
    let connection = await ctx.storage.connections.findById(input.id);
    if (!connection && isValidUrlSlug(input.id)) {
      const resolved = await ctx.storage.connections.resolveUrlSlug(
        organization.id,
        input.id,
        "connection",
      );
      connection = resolved
        ? await ctx.storage.connections.findById(resolved.id)
        : null;
    }

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
              return listManagementTools() as Promise<unknown[]>;
            }
          : () =>
              listToolsWithTimeout(connection, ctx, MCP_LIST_TOOLS_TIMEOUT_MS);
      const tools = await fetchWithCache(
        "tools",
        connection.id,
        fetchLive,
        getMcpListCache(),
        (p) => ctx.pendingRevalidations.push(p),
        REVALIDATE_MIN_INTERVAL_MS,
      );
      if (tools !== null) {
        connection.tools = tools as Tool[];
      }
    }

    return {
      item: redactConnectionToken(connection),
    };
  },
});
