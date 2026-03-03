/**
 * COLLECTION_CONNECTIONS_GET Tool
 *
 * Get connection details by ID with collection binding compliance.
 */

import {
  CollectionGetInputSchema,
  createCollectionGetOutputSchema,
} from "@decocms/bindings/collections";
import { defineTool } from "../../core/define-tool";
import { requireOrganization } from "../../core/mesh-context";
import { getBaseUrl } from "../../core/server-constants";
import { DownstreamTokenStorage } from "../../storage/downstream-token";
import {
  createDevAssetsConnectionEntity,
  isDevAssetsConnection,
  isDevMode,
} from "./dev-assets";
import { fetchToolsFromMCP } from "./fetch-tools";
import { ConnectionEntitySchema } from "./schema";

/**
 * Output schema using the ConnectionEntitySchema
 */
const ConnectionGetOutputSchema = createCollectionGetOutputSchema(
  ConnectionEntitySchema,
);

export const COLLECTION_CONNECTIONS_GET = defineTool({
  name: "COLLECTION_CONNECTIONS_GET",
  description: "Get connection details by ID",
  annotations: {
    title: "Get Connection",
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
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

    // Backfill tools when null (MCP server was unreachable at creation, OAuth
    // wasn't completed yet, etc.). VIRTUAL connections are skipped because
    // their tools are aggregated dynamically at runtime.
    if (!connection.tools && connection.connection_type !== "VIRTUAL") {
      try {
        let token = connection.connection_token ?? null;
        if (!token) {
          try {
            const tokenStorage = new DownstreamTokenStorage(ctx.db, ctx.vault);
            const cached = await tokenStorage.get(connection.id);
            if (cached?.accessToken) {
              token = cached.accessToken;
            }
          } catch {
            // Ignore token lookup errors
          }
        }

        const timeout = new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("Tool fetch timeout")), 2_000),
        );
        const fetchResult = await Promise.race([
          fetchToolsFromMCP({
            id: connection.id,
            title: connection.title,
            connection_type: connection.connection_type,
            connection_url: connection.connection_url,
            connection_token: token,
            connection_headers: connection.connection_headers,
          }),
          timeout,
        ]).catch(() => null);

        if (fetchResult?.tools?.length) {
          const updated = await ctx.storage.connections.update(connection.id, {
            tools: fetchResult.tools,
          });
          return { item: updated ?? connection };
        }
      } catch {
        // Best-effort: never block the response
      }
    }

    return {
      item: connection,
    };
  },
});
