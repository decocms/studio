/**
 * MCP Client Factory
 *
 * Top-level factory for creating MCP clients from connection entities.
 * Routes to appropriate factory based on connection type.
 */

import { WellKnownOrgMCPId } from "@decocms/shared/sdk";
import type { StudioContext } from "@/core/studio-context";
import type { ConnectionEntity } from "@/tools/connection/schema";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { createOutboundClient } from "./outbound";
import { createVirtualClient } from "./virtual-mcp";

/**
 * Create an MCP client from a connection entity
 *
 * Routes to the appropriate factory based on connection type:
 * - VIRTUAL: Creates a virtual MCP aggregator client
 * - STDIO, HTTP, Websocket, SSE: Creates an outbound client
 *
 * @param connection - Connection entity from database
 * @param ctx - Studio context for creating clients
 * @param superUser - Whether to use superuser mode for background processes
 * @returns Client instance connected to the MCP server
 */
export async function clientFromConnection(
  connection: ConnectionEntity,
  ctx: StudioContext,
  superUser = false,
): Promise<Client> {
  if (
    connection.organization_id &&
    (await ctx.storage.demo.get(connection.organization_id))
  ) {
    if (
      connection.id === WellKnownOrgMCPId.REPORTS(connection.organization_id)
    ) {
      const { createDemoReportsClient } = await import("@/demo/reports-client");
      return createDemoReportsClient(ctx, connection.organization_id);
    }
    await ctx.storage.demo.assertLive(connection.organization_id);
  }
  if (connection.connection_type === "VIRTUAL") {
    return createVirtualClient(connection, ctx, superUser);
  }
  return createOutboundClient(connection, ctx, superUser);
}
