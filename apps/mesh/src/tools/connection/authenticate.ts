/**
 * Connection Authentication Tools
 *
 * CONNECTION_AUTHENTICATE — Returns structured data for the frontend to render
 * an inline auth card. The tool itself is read-only — the UI handles the OAuth
 * mutation.
 *
 * CONNECTION_AUTH_STATUS — Check if a connection needs authentication and its
 * current health status.
 */

import { z } from "zod";
import { defineTool } from "../../core/define-tool";
import { requireOrganization } from "../../core/mesh-context";
import type { MeshContext } from "../../core/mesh-context";

// ---------------------------------------------------------------------------
// Shared helper
// ---------------------------------------------------------------------------

interface ConnectionRow {
  id: string;
  organization_id: string;
  title: string;
  icon?: string | null;
  description?: string | null;
  connection_url?: string | null;
  status?: string | null;
  oauth_config?: unknown;
  connection_token?: string | null;
  configuration_scopes?: unknown[] | null;
  configuration_state?: Record<string, unknown> | null;
}

async function checkAuth(
  connection: ConnectionRow,
  ctx: MeshContext,
): Promise<{
  isHealthy: boolean;
  hasOAuth: boolean;
  hasToken: boolean;
  hasScopes: boolean;
  hasConfigState: boolean;
}> {
  let isHealthy = false;
  try {
    const result = await ctx.storage.connections.testConnection(connection.id);
    isHealthy = result.healthy;
  } catch {
    // Connection unreachable
  }

  const hasOAuth = !!connection.oauth_config;
  const hasToken = !!connection.connection_token;
  const hasScopes =
    !!connection.configuration_scopes &&
    connection.configuration_scopes.length > 0;
  const hasConfigState =
    !!connection.configuration_state &&
    Object.keys(connection.configuration_state).length > 0;

  return { isHealthy, hasOAuth, hasToken, hasScopes, hasConfigState };
}

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

export const CONNECTION_AUTHENTICATE = defineTool({
  name: "CONNECTION_AUTHENTICATE",
  description:
    "Show an inline authentication card for a connection. The user can click to authenticate via OAuth popup.",
  annotations: {
    title: "Authenticate Connection",
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  inputSchema: z.object({
    connection_id: z.string().describe("Connection ID to authenticate"),
  }),
  outputSchema: z.object({
    connection_id: z.string(),
    title: z.string(),
    icon: z.string().nullable(),
    description: z.string().nullable(),
    connection_url: z.string().nullable(),
    status: z.enum(["active", "inactive", "error"]),
    needs_auth: z.boolean(),
    auth_type: z
      .enum(["oauth", "token", "configuration", "none"])
      .describe("Type of authentication required"),
  }),

  handler: async (input, ctx) => {
    const organization = requireOrganization(ctx);
    await ctx.access.check();

    const connection = await ctx.storage.connections.findById(
      input.connection_id,
    );
    if (!connection || connection.organization_id !== organization.id) {
      throw new Error("Connection not found");
    }

    const { isHealthy, hasOAuth, hasToken } = await checkAuth(connection, ctx);

    // Simple: oauth if oauth_config exists, token otherwise.
    // needs_auth = true when token is missing (and no oauth_config).
    let authType: "oauth" | "token" | "configuration" | "none" = "none";
    if (hasOAuth) {
      authType = "oauth";
    } else if (!hasToken) {
      authType = "token";
    }

    const needsAuth = hasOAuth ? !isHealthy : !hasToken;

    return {
      connection_id: connection.id,
      title: connection.title,
      icon: connection.icon ?? null,
      description: connection.description ?? null,
      connection_url: connection.connection_url ?? null,
      status: connection.status ?? "inactive",
      needs_auth: needsAuth,
      auth_type: authType,
    };
  },
});

export const CONNECTION_AUTH_STATUS = defineTool({
  name: "CONNECTION_AUTH_STATUS",
  description:
    "Check if a connection needs authentication and its current health status",
  annotations: {
    title: "Connection Auth Status",
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  },
  inputSchema: z.object({
    id: z.string().describe("Connection ID to check"),
  }),
  outputSchema: z.object({
    connection_id: z.string(),
    title: z.string(),
    icon: z.string().nullable(),
    status: z.enum(["active", "inactive", "error"]),
    needs_auth: z.boolean(),
    is_healthy: z.boolean(),
  }),

  handler: async (input, ctx) => {
    const organization = requireOrganization(ctx);
    await ctx.access.check();

    const connection = await ctx.storage.connections.findById(input.id);
    if (!connection || connection.organization_id !== organization.id) {
      throw new Error("Connection not found");
    }

    const { isHealthy, hasOAuth, hasScopes, hasConfigState } = await checkAuth(
      connection,
      ctx,
    );

    // Determine if auth is needed:
    // - Connection is unhealthy AND has OAuth config or scopes
    // - Connection has configuration_scopes but no configuration_state values
    const needsAuth =
      !isHealthy && (hasOAuth || (hasScopes && !hasConfigState));

    return {
      connection_id: connection.id,
      title: connection.title,
      icon: connection.icon ?? null,
      status: connection.status ?? "inactive",
      needs_auth: needsAuth,
      is_healthy: isHealthy,
    };
  },
});
