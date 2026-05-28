/**
 * CONNECTION_TEST Tool
 *
 * Test connection health
 */

import { z } from "zod";
import { defineTool } from "../../core/define-tool";
import { requireOrganization } from "../../core/mesh-context";

export const CONNECTION_TEST = defineTool({
  name: "CONNECTION_TEST",
  description: "Test connection health and latency",
  annotations: {
    title: "Test Connection",
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  },
  inputSchema: z.object({
    id: z.string(),
  }),

  outputSchema: z.object({
    id: z.string(),
    healthy: z.boolean(),
    latencyMs: z.number(),
  }),

  handler: async (input, ctx) => {
    // Require organization context
    const organization = requireOrganization(ctx);

    // Check authorization
    await ctx.access.check();

    // Fetch connection to verify org ownership before testing.
    // viewerUserId hides other users' user-private connections.
    const connection = await ctx.storage.connections.findById(
      input.id,
      organization.id,
      ctx.auth.user?.id ?? ctx.auth.apiKey?.userId ?? null,
    );
    if (!connection || connection.organization_id !== organization.id) {
      throw new Error("Connection not found");
    }

    // Test connection
    const result = await ctx.storage.connections.testConnection(input.id);

    return {
      id: input.id,
      ...result,
    };
  },
});
