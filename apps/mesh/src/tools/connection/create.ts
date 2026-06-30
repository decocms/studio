/**
 * COLLECTION_CONNECTIONS_CREATE Tool
 *
 * Create a new MCP connection (organization-scoped) with collection binding compliance.
 */
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { posthog } from "../../posthog";
import { defineTool } from "../../core/define-tool";
import {
  getUserId,
  requireAuth,
  requireOrganization,
} from "../../core/studio-context";
import { getSettings } from "../../settings";
import { getMcpListCache } from "../../mcp-clients/mcp-list-cache";
import { clientFromConnection } from "../../mcp-clients";
import {
  deriveCredentialGrants,
  injectSelfSentinel,
  validateConfiguration,
} from "./credential-grants";
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
  description:
    "Create a new MCP connection. Auto-fetches and caches the server's tool list.",
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

    if (connectionData.id) {
      const existing = await ctx.storage.connections.findById(
        connectionData.id,
      );
      if (existing?.organization_id === organization.id) {
        throw new Error("Connection already exists in organization");
      }
    }

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

    // STDIO connections spawn arbitrary local commands — only allow in local mode.
    // Without this check, the fetchToolsFromMCP call below would spawn
    // user-supplied commands as child processes on the server.
    if (
      connectionData.connection_type === "STDIO" &&
      !getSettings().localMode
    ) {
      throw new Error(
        "STDIO connections are only available in local mode (--local-mode).",
      );
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
    const configurationScopes = fetchResult?.scopes?.length
      ? fetchResult.scopes
      : (connectionData.configuration_scopes ?? null);
    const configurationState = connectionData.configuration_state ?? null;

    if (configurationState && configurationScopes?.length) {
      injectSelfSentinel(
        configurationState as Record<string, unknown>,
        configurationScopes,
        organization.id,
      );
      await validateConfiguration(
        configurationState as Record<string, unknown>,
        configurationScopes,
        organization.id,
        ctx,
      );
    }

    // Create the connection with the fetched tools and scopes. This must be
    // insert-only: ConnectionStorage.create is intentionally upsert-like for
    // legacy callers, but this tool owns cleanup on bootstrap failure.
    const connection = await ctx.storage.connections.createNew({
      ...connectionData,
      tools: null,
      configuration_state: configurationState,
      configuration_scopes: configurationScopes,
    });

    const credentialGrants =
      configurationState && configurationScopes?.length
        ? deriveCredentialGrants(
            configurationState as Record<string, unknown>,
            configurationScopes,
          )
        : [];

    if (credentialGrants.length > 0) {
      let createdWorkloadTokenId: string | undefined;
      try {
        await ctx.storage.connectionCredentialVault.replaceGrantsForSubject({
          organizationId: organization.id,
          subjectConnectionId: connection.id,
          createdBy: userId,
          grants: credentialGrants,
        });
        const { plaintextToken, record } =
          await ctx.storage.connectionCredentialVault.createOrRotateWorkloadToken(
            {
              organizationId: organization.id,
              subjectConnectionId: connection.id,
            },
          );
        createdWorkloadTokenId = record.id;

        const client = await clientFromConnection(connection, ctx, false);
        await client.callTool({
          name: "ON_MCP_CONFIGURATION",
          arguments: {
            state: configurationState,
            scopes: configurationScopes,
            firstRun: true,
            vault: {
              baseUrl: ctx.baseUrl,
              org: organization.slug ?? organization.id,
              subjectConnectionId: connection.id,
              token: plaintextToken,
            },
          },
        });
      } catch (error) {
        if (createdWorkloadTokenId) {
          await ctx.storage.connectionCredentialVault.revokeWorkloadToken({
            organizationId: organization.id,
            subjectConnectionId: connection.id,
            tokenId: createdWorkloadTokenId,
          });
        }
        await ctx.storage.connections.delete(connection.id);
        throw error;
      }
    }

    // Eagerly populate NATS KV cache with fetched tools
    if (tools) {
      getMcpListCache()
        ?.set("tools", connection.id, tools as Tool[])
        .catch(() => {});
    }

    posthog.capture({
      distinctId: userId,
      event: "connection_created",
      groups: { organization: organization.id },
      properties: {
        connection_id: connection.id,
        connection_type: connection.connection_type,
        app_name: connection.app_name ?? null,
        organization_id: organization.id,
        tools_count: tools?.length ?? 0,
      },
    });

    return {
      item: connection,
    };
  },
});
