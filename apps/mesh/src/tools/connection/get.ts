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

    return {
      item: connection,
    };
  },
});
