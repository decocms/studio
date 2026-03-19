/**
 * CONNECTION_AUTHENTICATE & CONNECTION_AUTH_STATUS Tools
 *
 * Returns auth card data for inline authentication in the chat UI.
 * Never returns secrets (connection_token, connection_headers, oauth_config, configuration_state).
 */

import { z } from "zod";
import { defineTool } from "../../core/define-tool";
import { requireOrganization } from "../../core/mesh-context";

/**
 * Check whether a connection needs authentication by inspecting
 * its oauth_config, configuration_scopes, configuration_state, and tools.
 */
async function checkAuth(
  connectionId: string,
  organizationId: string,
  ctx: {
    storage: {
      connections: {
        findById(
          id: string,
          orgId?: string,
        ): Promise<Record<string, unknown> | null>;
        testConnection(
          id: string,
        ): Promise<{ healthy: boolean; latencyMs: number }>;
      };
    };
  },
) {
  const connection = await ctx.storage.connections.findById(
    connectionId,
    organizationId,
  );

  if (!connection) {
    throw new Error("Connection not found");
  }

  if (connection.organization_id !== organizationId) {
    throw new Error("Connection not found");
  }

  // Test connection health
  let isHealthy = false;
  try {
    const result = await ctx.storage.connections.testConnection(connectionId);
    isHealthy = result.healthy;
  } catch {
    isHealthy = false;
  }

  // Determine if auth is needed:
  // 1. Has oauth_config but no connection_token → needs OAuth
  // 2. Has configuration_scopes but no configuration_state → needs config
  // 3. Has a tool named MCP_CONFIGURATION in tools list → needs config
  const hasOAuthConfig = !!connection.oauth_config;
  const hasToken = !!connection.connection_token;
  const hasScopes =
    Array.isArray(connection.configuration_scopes) &&
    (connection.configuration_scopes as string[]).length > 0;
  const hasConfigState =
    connection.configuration_state != null &&
    typeof connection.configuration_state === "object" &&
    Object.keys(connection.configuration_state as object).length > 0;
  const hasMcpConfigTool =
    Array.isArray(connection.tools) &&
    (connection.tools as { name: string }[]).some(
      (t) => t.name === "MCP_CONFIGURATION",
    );

  let needsAuth = false;
  let authType: "oauth" | "token" | "none" = "none";

  if (hasOAuthConfig && !hasToken) {
    needsAuth = true;
    authType = "oauth";
  } else if ((hasScopes && !hasConfigState) || hasMcpConfigTool) {
    needsAuth = true;
    authType = "token";
  } else if (!isHealthy && !hasToken) {
    needsAuth = true;
    authType = "token";
  }

  return {
    connection,
    needsAuth,
    authType,
    isHealthy,
  };
}

// ============================================================================
// CONNECTION_AUTHENTICATE
// ============================================================================

const AuthenticateInputSchema = z.object({
  connection_id: z.string().describe("The connection ID to authenticate"),
});

const AuthenticateOutputSchema = z.object({
  connection_id: z.string(),
  title: z.string(),
  icon: z.string().nullable(),
  description: z.string().nullable(),
  connection_url: z.string().nullable(),
  status: z.string(),
  needs_auth: z.boolean(),
  auth_type: z.enum(["oauth", "token", "none"]),
});

export const CONNECTION_AUTHENTICATE = defineTool({
  name: "CONNECTION_AUTHENTICATE",
  description:
    "Get authentication card data for a connection. Returns structured data for the frontend to render an inline auth card. Does NOT perform actual authentication — the frontend handles OAuth popup or token input.",
  annotations: {
    title: "Authenticate Connection",
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  inputSchema: AuthenticateInputSchema,
  outputSchema: AuthenticateOutputSchema,

  handler: async (input, ctx) => {
    const organization = requireOrganization(ctx);
    await ctx.access.check();

    const { connection, needsAuth, authType } = await checkAuth(
      input.connection_id,
      organization.id,
      ctx,
    );

    return {
      connection_id: connection.id as string,
      title: connection.title as string,
      icon: (connection.icon as string | null) ?? null,
      description: (connection.description as string | null) ?? null,
      connection_url: (connection.connection_url as string | null) ?? null,
      status: connection.status as string,
      needs_auth: needsAuth,
      auth_type: authType,
    };
  },
});

// ============================================================================
// CONNECTION_AUTH_STATUS
// ============================================================================

const AuthStatusInputSchema = z.object({
  connection_id: z.string().describe("The connection ID to check auth status"),
});

const AuthStatusOutputSchema = z.object({
  connection_id: z.string(),
  title: z.string(),
  icon: z.string().nullable(),
  status: z.string(),
  needs_auth: z.boolean(),
  is_healthy: z.boolean(),
});

export const CONNECTION_AUTH_STATUS = defineTool({
  name: "CONNECTION_AUTH_STATUS",
  description:
    "Check if a connection needs authentication and its current health status.",
  annotations: {
    title: "Connection Auth Status",
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  inputSchema: AuthStatusInputSchema,
  outputSchema: AuthStatusOutputSchema,

  handler: async (input, ctx) => {
    const organization = requireOrganization(ctx);
    await ctx.access.check();

    const { connection, needsAuth, isHealthy } = await checkAuth(
      input.connection_id,
      organization.id,
      ctx,
    );

    return {
      connection_id: connection.id as string,
      title: connection.title as string,
      icon: (connection.icon as string | null) ?? null,
      status: connection.status as string,
      needs_auth: needsAuth,
      is_healthy: isHealthy,
    };
  },
});
