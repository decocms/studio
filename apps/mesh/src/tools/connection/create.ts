/**
 * COLLECTION_CONNECTIONS_CREATE Tool
 *
 * Create a new MCP connection (organization-scoped) with collection binding compliance.
 */

import { WellKnownOrgMCPId } from "@decocms/mesh-sdk";
import { z } from "zod";
import { defineTool } from "../../core/define-tool";
import {
  getUserId,
  requireAuth,
  requireOrganization,
} from "../../core/mesh-context";
import { fetchToolsFromMCP } from "./fetch-tools";
import {
  buildVirtualUrl,
  ConnectionCreateDataSchema,
  ConnectionEntitySchema,
  parseVirtualUrl,
} from "./schema";

/**
 * Input schema for creating connections (wrapped in data field for collection compliance)
 */
const CreateInputSchema = z.object({
  data: ConnectionCreateDataSchema.describe(
    "Data for the new connection (id is auto-generated if not provided)",
  ),
});

export type CreateConnectionInput = z.infer<typeof CreateInputSchema>;
/**
 * Output schema for created connection
 */
const CreateOutputSchema = z.object({
  item: ConnectionEntitySchema.describe("The created connection entity"),
});

export const COLLECTION_CONNECTIONS_CREATE = defineTool({
  name: "COLLECTION_CONNECTIONS_CREATE",
  description: "Create a new MCP connection in the organization",
  annotations: {
    title: "Create Connection",
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: false,
    openWorldHint: false,
  },
  inputSchema: CreateInputSchema,
  outputSchema: CreateOutputSchema,

  handler: async (input, ctx) => {
    requireAuth(ctx);
    const organization = requireOrganization(ctx);

    await ctx.access.check();

    const userId = getUserId(ctx);
    if (!userId) {
      throw new Error("User ID required to create connection");
    }

    // Build connection data
    const connectionData = {
      ...input.data,
      organization_id: organization.id,
      created_by: userId,
    };

    // Validate VIRTUAL connections - ensure the referenced Virtual MCP exists
    if (connectionData.connection_type === "VIRTUAL") {
      const virtualMcpId = parseVirtualUrl(connectionData.connection_url);
      if (!virtualMcpId) {
        throw new Error(
          "VIRTUAL connection requires connection_url in format: virtual://$virtual_mcp_id",
        );
      }

      const virtualMcp = await ctx.storage.virtualMcps.findById(virtualMcpId);
      if (!virtualMcp) {
        throw new Error(`Virtual MCP not found: ${virtualMcpId}`);
      }

      // Verify the Virtual MCP belongs to the same organization
      if (virtualMcp.organization_id !== organization.id) {
        throw new Error(
          "Virtual MCP does not belong to the current organization",
        );
      }

      // Ensure the URL is properly formatted
      connectionData.connection_url = buildVirtualUrl(virtualMcpId);
    }

    // Fetch tools and configuration scopes from the MCP server before creating the connection
    // VIRTUAL connections return null since tools are fetched dynamically
    const fetchResult = await fetchToolsFromMCP({
      id: `pending-${Date.now()}`,
      title: connectionData.title,
      connection_type: connectionData.connection_type,
      connection_url: connectionData.connection_url,
      connection_token: connectionData.connection_token,
      connection_headers: connectionData.connection_headers,
    }).catch(() => null);
    const tools = fetchResult?.tools?.length ? fetchResult.tools : null;
    const configuration_scopes = fetchResult?.scopes?.length
      ? fetchResult.scopes
      : null;

    // Flag needs_auth if the MCP declared scopes or has MCP_CONFIGURATION.
    // Don't use !fetchResult — VIRTUAL connections return null by design.
    const hasMcpConfig = tools?.some((t) => t.name === "MCP_CONFIGURATION");
    const needsAuth = !!configuration_scopes || !!hasMcpConfig;
    const metadata = {
      ...(connectionData.metadata as Record<string, unknown> | null),
      ...(needsAuth ? { needs_auth: true } : {}),
    };

    // Create the connection with the fetched tools and scopes
    const connection = await ctx.storage.connections.create({
      ...connectionData,
      tools,
      configuration_scopes,
      metadata,
    });

    await ctx.eventBus.publish(
      organization.id,
      WellKnownOrgMCPId.SELF(organization.id),
      {
        type: "connection.created",
        data: connection,
      },
    );

    return {
      item: connection,
    };
  },
});
