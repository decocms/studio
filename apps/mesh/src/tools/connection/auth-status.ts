/**
 * CONNECTION_AUTH_STATUS Tool
 *
 * Check if a connection needs authentication.
 */

import { z } from "zod";
import { defineTool } from "../../core/define-tool";
import { requireOrganization } from "../../core/mesh-context";

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

    // Test health
    let isHealthy = false;
    try {
      const result = await ctx.storage.connections.testConnection(input.id);
      isHealthy = result.healthy;
    } catch {
      // Connection unreachable
    }

    // Determine if auth is needed:
    // - Connection is unhealthy AND has OAuth config or scopes
    // - Connection has configuration_scopes but no configuration_state values
    const hasOAuth = !!connection.oauth_config;
    const hasScopes =
      connection.configuration_scopes &&
      connection.configuration_scopes.length > 0;
    const needsAuth = !isHealthy && (hasOAuth || !!hasScopes);

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
