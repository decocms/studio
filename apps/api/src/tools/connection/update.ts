/**
 * COLLECTION_CONNECTIONS_UPDATE Tool
 *
 * Update an existing MCP connection (organization-scoped) with collection binding compliance.
 * Also handles MCP configuration state and scopes validation.
 */

import { clientFromConnection } from "@/mcp-clients";
import { DownstreamTokenStorage } from "@/storage/downstream-token";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { defineTool } from "../../core/define-tool";
import {
  getUserId,
  requireAuth,
  requireOrganization,
} from "../../core/studio-context";
import { getSettings } from "../../settings";
import { getMcpListCache } from "../../mcp-clients/mcp-list-cache";
import { invalidateConnectionCaches } from "../../mcp-clients/mcp-cache-invalidation";
import {
  deriveCredentialGrants,
  injectSelfSentinel,
  validateConfiguration,
} from "./credential-grants";
import { fetchToolsFromMCP } from "./fetch-tools";
import {
  buildVirtualUrl,
  type ConnectionEntity,
  ConnectionEntitySchema,
  type ConnectionUpdateData,
  ConnectionUpdateDataSchema,
  parseVirtualUrl,
} from "./schema";

/**
 * Fields that are system-managed and must never be settable through
 * COLLECTION_CONNECTIONS_UPDATE. ConnectionUpdateDataSchema is
 * ConnectionEntitySchema.partial(), so without this a caller with ordinary
 * connection-update permission could reassign a connection to a different
 * organization (organization_id), forge its creator (created_by), backdate
 * it (created_at), or rewrite its primary key (id).
 */
const IMMUTABLE_UPDATE_FIELDS = [
  "id",
  "organization_id",
  "created_by",
  "created_at",
] as const;

export function stripImmutableUpdateFields(
  data: ConnectionUpdateData,
): ConnectionUpdateData {
  const sanitized = { ...data };
  for (const field of IMMUTABLE_UPDATE_FIELDS) {
    delete sanitized[field];
  }
  return sanitized;
}

/**
 * `connection_url` is nullable, so `data.connection_url ?? existing` would
 * silently keep the old URL when a caller explicitly clears it (e.g.
 * switching connection_type to STDIO). Only fall back when the field was
 * omitted, not when it was explicitly set to null.
 */
export function resolveFinalConnectionUrl(
  data: ConnectionUpdateData,
  existingConnectionUrl: string | null,
): string | null {
  return data.connection_url !== undefined
    ? data.connection_url
    : existingConnectionUrl;
}

/**
 * Input schema for updating connections
 */
const UpdateInputSchema = z.object({
  id: z.string().describe("ID of the connection to update"),
  data: ConnectionUpdateDataSchema.describe(
    "Partial connection data to update",
  ),
});

/**
 * Output schema for updated connection
 */
const UpdateOutputSchema = z.object({
  item: ConnectionEntitySchema.describe("The updated connection entity"),
});

function stringArraysEqual(left: string[], right: string[]): boolean {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}

export const COLLECTION_CONNECTIONS_UPDATE = defineTool({
  name: "COLLECTION_CONNECTIONS_UPDATE",
  description:
    "Update a connection's configuration. Re-fetches tools from the server on URL change.",
  annotations: {
    title: "Update Connection",
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: true,
    openWorldHint: false,
  },
  inputSchema: UpdateInputSchema,
  outputSchema: UpdateOutputSchema,

  handler: async (input, ctx) => {
    // Require authentication
    requireAuth(ctx);

    // Require organization context
    const organization = requireOrganization(ctx);

    // Check authorization
    await ctx.access.check();

    const userId = getUserId(ctx);
    if (!userId) {
      throw new Error("User ID required to update connection");
    }

    const { id } = input;
    const data = stripImmutableUpdateFields(input.data);
    const configChanged =
      data.configuration_state !== undefined ||
      data.configuration_scopes !== undefined;

    // First fetch the connection to verify ownership before updating
    const existing = await ctx.storage.connections.findById(id);

    // Verify it exists and belongs to the current organization
    if (!existing || existing.organization_id !== organization.id) {
      throw new Error("Connection not found in organization");
    }

    // Validate VIRTUAL connections if connection_type or connection_url is being updated
    const finalConnectionType =
      data.connection_type ?? existing.connection_type;
    let finalConnectionUrl = resolveFinalConnectionUrl(
      data,
      existing.connection_url,
    );

    if (finalConnectionType === "VIRTUAL") {
      const virtualMcpId = parseVirtualUrl(finalConnectionUrl);
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
      finalConnectionUrl = buildVirtualUrl(virtualMcpId);
    }

    // Handle MCP configuration state and scopes if present
    // IMPORTANT: configuration_state must never be null/undefined to ensure
    // it's always included in the JWT token sent to downstream connections
    let finalState =
      data.configuration_state ?? existing.configuration_state ?? {};
    let finalScopes =
      data.configuration_scopes ?? existing.configuration_scopes ?? [];

    // If configuration fields are being updated, validate them
    if (configChanged) {
      // Merge state: use provided state, or keep existing
      if (data.configuration_state !== undefined) {
        finalState = data.configuration_state ?? {};
      } else if (finalState === null || finalState === undefined) {
        finalState = {};
      }

      // Use provided scopes or existing ones
      if (data.configuration_scopes !== undefined) {
        finalScopes = data.configuration_scopes ?? [];
      }

      // Validate configuration if we have scopes
      if (finalScopes.length > 0) {
        const stateObj = finalState as Record<string, unknown>;
        injectSelfSentinel(stateObj, finalScopes, organization.id);
        await validateConfiguration(
          stateObj,
          finalScopes,
          organization.id,
          ctx,
        );
      }
    }

    // STDIO connections spawn arbitrary local commands — only allow in local mode.
    if (finalConnectionType === "STDIO" && !getSettings().localMode) {
      throw new Error(
        "STDIO connections are only available in local mode (--local-mode).",
      );
    }

    // Fetch tools from the MCP server.
    // If the connection uses OAuth (token stored in downstream_tokens), use the
    // access token to discover tools after authentication.
    let tokenForToolFetch = data.connection_token ?? existing.connection_token;
    if (!tokenForToolFetch) {
      try {
        const tokenStorage = new DownstreamTokenStorage(ctx.db, ctx.vault);
        const cachedToken = await tokenStorage.get(id);
        if (cachedToken?.accessToken) {
          tokenForToolFetch = cachedToken.accessToken;
        }
      } catch {
        // Ignore token lookup errors and fall back to unauthenticated discovery.
      }
    }

    const fetchResult = await fetchToolsFromMCP({
      id: existing.id,
      title: data.title ?? existing.title,
      connection_type: finalConnectionType,
      connection_url: finalConnectionUrl,
      connection_token: tokenForToolFetch,
      connection_headers:
        data.connection_headers ?? existing.connection_headers,
    }).catch(() => null);
    const tools = fetchResult?.tools?.length ? fetchResult.tools : null;

    // Auto-populate scopes from MCP_CONFIGURATION when not explicitly provided by the caller
    let autoScopesChanged = false;
    if (
      data.configuration_scopes === undefined &&
      fetchResult?.scopes?.length
    ) {
      autoScopesChanged = !stringArraysEqual(finalScopes, fetchResult.scopes);
      finalScopes = fetchResult.scopes;
    }

    // Covers the fetchResult auto-scopes path: if an MCP server advertises
    // SELF:: scopes via MCP_CONFIGURATION (and the caller didn't trigger the
    // explicit-config validation block above), we still need SELF in state so
    // the downstream JWT includes the correct self-endpoint permissions.
    // If SELF was already injected above this is a no-op.
    injectSelfSentinel(
      finalState as Record<string, unknown>,
      finalScopes,
      organization.id,
    );

    if (autoScopesChanged && finalScopes.length > 0) {
      await validateConfiguration(
        finalState as Record<string, unknown>,
        finalScopes,
        organization.id,
        ctx,
      );
    }

    const savedConfigurationChanged = configChanged || autoScopesChanged;
    const credentialGrants = savedConfigurationChanged
      ? deriveCredentialGrants(
          finalState as Record<string, unknown>,
          finalScopes,
        )
      : [];
    const previousCredentialGrants = savedConfigurationChanged
      ? deriveCredentialGrants(
          (existing.configuration_state ?? {}) as Record<string, unknown>,
          existing.configuration_scopes ?? [],
        )
      : [];
    // firstRun fires the MCP's onInstall hook exactly once: true when the
    // connection had no prior configuration_state (its first config save).
    const priorState = existing.configuration_state as Record<
      string,
      unknown
    > | null;
    const firstRun = priorState == null || Object.keys(priorState).length === 0;
    let vaultBootstrap:
      | {
          baseUrl: string;
          org: string;
          subjectConnectionId: string;
          token: string;
        }
      | undefined;
    let createdWorkloadTokenId: string | undefined;

    const restorePreviousCredentialGrants = async () => {
      try {
        await ctx.storage.connectionCredentialVault.replaceGrantsForSubject({
          organizationId: organization.id,
          subjectConnectionId: id,
          createdBy: userId,
          grants: previousCredentialGrants,
        });
      } catch (restoreError) {
        console.error(
          "Failed to restore credential grants after credential vault mutation failed",
          restoreError,
        );
      }
    };

    const updatePayload: Partial<ConnectionEntity> = {
      ...data,
      connection_url: finalConnectionUrl,
      tools: null,
      configuration_state: finalState,
      configuration_scopes: finalScopes,
      updated_by: userId,
    };
    const connectionForCallback = {
      ...existing,
      ...updatePayload,
    } as ConnectionEntity;

    if (savedConfigurationChanged) {
      try {
        await ctx.storage.connectionCredentialVault.replaceGrantsForSubject({
          organizationId: organization.id,
          subjectConnectionId: id,
          createdBy: userId,
          grants: credentialGrants,
        });

        if (credentialGrants.length > 0) {
          const activeToken =
            await ctx.storage.connectionCredentialVault.findActiveWorkloadToken(
              {
                organizationId: organization.id,
                subjectConnectionId: id,
              },
            );

          if (!activeToken) {
            const { plaintextToken, record } =
              await ctx.storage.connectionCredentialVault.createOrRotateWorkloadToken(
                {
                  organizationId: organization.id,
                  subjectConnectionId: id,
                },
              );
            createdWorkloadTokenId = record.id;
            vaultBootstrap = {
              baseUrl: ctx.baseUrl,
              org: organization.slug ?? organization.id,
              subjectConnectionId: id,
              token: plaintextToken,
            };
          }
        }
      } catch (error) {
        if (createdWorkloadTokenId) {
          await ctx.storage.connectionCredentialVault.revokeWorkloadToken({
            organizationId: organization.id,
            subjectConnectionId: id,
            tokenId: createdWorkloadTokenId,
          });
        }
        await restorePreviousCredentialGrants();
        throw error;
      }
    }

    // Invoke ON_MCP_CONFIGURATION callback if configuration was updated
    // Ignore errors but await for the response before responding
    if (savedConfigurationChanged && finalState && finalScopes) {
      try {
        // Create client - pool manages lifecycle, best-effort call
        const client = await clientFromConnection(
          connectionForCallback,
          ctx,
          false,
        );

        await client.callTool({
          name: "ON_MCP_CONFIGURATION",
          arguments: {
            state: finalState,
            scopes: finalScopes,
            firstRun,
            ...(vaultBootstrap ? { vault: vaultBootstrap } : {}),
          },
        });
      } catch (error) {
        console.error("Failed to invoke ON_MCP_CONFIGURATION callback", error);
        if (createdWorkloadTokenId) {
          await ctx.storage.connectionCredentialVault.revokeWorkloadToken({
            organizationId: organization.id,
            subjectConnectionId: id,
            tokenId: createdWorkloadTokenId,
          });
        }
        // Always roll back the replaced grants, even without a new token.
        await restorePreviousCredentialGrants();
        throw error;
      }
    }

    // Update the connection after any required vault bootstrap succeeds. This
    // keeps mixed updates atomic from the caller's point of view when bootstrap
    // plaintext would otherwise be lost.
    let connection: ConnectionEntity;
    try {
      connection = await ctx.storage.connections.update(id, updatePayload);
    } catch (error) {
      if (savedConfigurationChanged) {
        if (createdWorkloadTokenId) {
          await ctx.storage.connectionCredentialVault.revokeWorkloadToken({
            organizationId: organization.id,
            subjectConnectionId: id,
            tokenId: createdWorkloadTokenId,
          });
        }
        await restorePreviousCredentialGrants();
      }
      throw error;
    }

    // Eagerly populate NATS KV cache with fetched tools
    if (tools) {
      getMcpListCache()
        ?.set("tools", id, tools as Tool[])
        .catch(() => {});
    }
    // Config/auth/url may have changed — drop cached read content and tool
    // results across ALL replicas (per-pod caches → NATS broadcast) so stale
    // (possibly now-unauthorized) responses aren't served against the new config.
    invalidateConnectionCaches(id);

    return {
      item: connection,
    };
  },
});
