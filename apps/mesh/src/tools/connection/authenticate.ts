/**
 * CONNECTION_AUTHENTICATE Tool
 *
 * Returns structured data for the frontend to render an inline auth card.
 * The tool itself is read-only — the UI handles the OAuth mutation.
 */

import { z } from "zod";
import { defineTool } from "../../core/define-tool";
import { requireOrganization } from "../../core/mesh-context";

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

    // Test health
    let isHealthy = false;
    try {
      const result = await ctx.storage.connections.testConnection(
        input.connection_id,
      );
      isHealthy = result.healthy;
    } catch {
      // Connection unreachable
    }

    // Determine auth type
    const hasOAuth = !!connection.oauth_config;
    const hasScopes =
      connection.configuration_scopes &&
      connection.configuration_scopes.length > 0;
    // MCP_CONFIGURATION tool = server expects configuration (e.g. API key).
    // Some MCPs (Perplexity) respond to ping/listTools without auth but fail
    // on actual tool calls, so health check alone is not sufficient.
    const tools = (connection.tools ?? []) as { name: string }[];
    const hasMcpConfig = tools.some((t) => t.name === "MCP_CONFIGURATION");
    const needsToken = hasMcpConfig && !connection.connection_token;

    let authType: "oauth" | "token" | "configuration" | "none" = "none";
    if (hasOAuth) {
      authType = "oauth";
    } else if (hasScopes) {
      authType = "configuration";
    } else if (needsToken) {
      authType = "token";
    } else if (!isHealthy && connection.connection_token) {
      authType = "token";
    } else if (!isHealthy && connection.connection_url) {
      authType = "token";
    }

    const needsAuth = (!isHealthy && authType !== "none") || needsToken;

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
