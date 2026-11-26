/**
 * COLLECTION_CONNECTIONS_UPDATE Tool
 *
 * Update an existing MCP connection (organization-scoped) with collection binding compliance.
 * Also handles MCP configuration state and scopes validation.
 */

import { DownstreamTokenStorage } from "@/storage/downstream-token";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { restoreSecretConfiguration } from "@decocms/shared/sdk";
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
import { provisionOrderIngest } from "../../monitoring/order-ingest-install";
import { injectSelfSentinel, validateConfiguration } from "./credential-grants";
import { fetchToolsFromMCP } from "./fetch-tools";
import { saveConnectionWithConfiguration } from "./save-configuration";
import { assertMayMoveCredentials } from "./credential-origin-guard";
import { toPublicConnection } from "./public-connection";
import { assertSiteSlugUnchanged } from "../virtual/site-slug-guard";
import { pinnedSiteSlugOnRename } from "../virtual/pin-site-slug";
import {
  buildVirtualUrl,
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

    // A VIRTUAL row is a project: its metadata carries the immutable site slug,
    // which this generic write must neither change nor drop — nor move by a
    // rename, for a legacy project whose slug is still its title.
    if (
      existing.connection_type === "VIRTUAL" &&
      (data.metadata !== undefined || data.title !== undefined)
    ) {
      const project = await ctx.storage.virtualMcps.findById(existing.id);
      if (project) {
        if (data.metadata !== undefined) {
          assertSiteSlugUnchanged(project, data.metadata);
          const siteSlug = project.metadata?.siteSlug;
          if (siteSlug) data.metadata = { ...data.metadata, siteSlug };
        }
        const pinned = pinnedSiteSlugOnRename({
          nextTitle: data.title,
          currentTitle: project.title,
          currentSiteSlug: project.metadata?.siteSlug,
        });
        if (pinned) {
          data.metadata = {
            ...(data.metadata ?? project.metadata ?? {}),
            siteSlug: pinned,
          };
        }
      }
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

    await assertMayMoveCredentials(ctx, existing, finalConnectionUrl);

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
        finalState = restoreSecretConfiguration(
          data.configuration_state ?? {},
          existing.configuration_state,
        );
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
    let tokenForToolFetch =
      data.connection_token !== undefined
        ? data.connection_token
        : existing.connection_token;
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
    const updatePayload = {
      ...data,
      connection_url: finalConnectionUrl,
      tools: null,
      configuration_state: finalState as Record<string, unknown>,
      configuration_scopes: finalScopes,
      configuration_secret_fields:
        fetchResult?.secretFields ?? existing.configuration_secret_fields,
      // secretFields is null when MCP_CONFIGURATION did not answer.
      configuration_secret_delivery: fetchResult?.secretFields
        ? (fetchResult.secretDelivery ?? null)
        : existing.configuration_secret_delivery,
      updated_by: userId,
    };
    const connection = await saveConnectionWithConfiguration(ctx, {
      organization,
      userId,
      existing,
      update: updatePayload,
      configurationChanged: savedConfigurationChanged,
    });

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

    if (savedConfigurationChanged) {
      await provisionOrderIngest(ctx, { organization, userId, connection });
    }

    return {
      item: toPublicConnection(connection),
    };
  },
});
