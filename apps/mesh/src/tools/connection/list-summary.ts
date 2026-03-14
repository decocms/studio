/**
 * COLLECTION_CONNECTIONS_LIST_SUMMARY Tool
 *
 * Lightweight connection listing — returns metadata only, no tool schemas.
 * Designed for AI agents that need to quickly see what's connected.
 */

import { z } from "zod";
import { defineTool } from "../../core/define-tool";
import { requireOrganization } from "../../core/mesh-context";

const ConnectionSummarySchema = z.object({
  id: z.string(),
  title: z.string(),
  description: z.string().nullable(),
  icon: z.string().nullable(),
  connection_type: z.string(),
  status: z.string().nullable(),
  tools_count: z.number(),
});

export const COLLECTION_CONNECTIONS_LIST_SUMMARY = defineTool({
  name: "COLLECTION_CONNECTIONS_LIST_SUMMARY",
  description:
    "List all connections with lightweight metadata (no tool schemas). Use this for a quick overview of what's connected.",
  annotations: {
    title: "List Connections (Summary)",
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  inputSchema: z.object({}),
  outputSchema: z.object({
    connections: z.array(ConnectionSummarySchema),
    totalCount: z.number(),
  }),

  handler: async (_input, ctx) => {
    const organization = requireOrganization(ctx);
    await ctx.access.check();

    const connections = await ctx.storage.connections.list(organization.id, {
      includeVirtual: false,
    });

    return {
      connections: connections.map((c) => ({
        id: c.id,
        title: c.title,
        description: c.description ?? null,
        icon: c.icon ?? null,
        connection_type: c.connection_type,
        status: c.status ?? null,
        tools_count: c.tools?.length ?? 0,
      })),
      totalCount: connections.length,
    };
  },
});
