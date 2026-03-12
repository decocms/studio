/**
 * MCP Client Factory
 *
 * Top-level factory for creating MCP clients from connection entities.
 * Routes to appropriate factory based on connection type.
 */

import type { MeshContext } from "@/core/mesh-context";
import type { ConnectionEntity } from "@/tools/connection/schema";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { createLocalClient } from "./local";
import { createOutboundClient } from "./outbound";
import { createVirtualClient } from "./virtual-mcp";

/**
 * Create an MCP client from a connection entity
 *
 * Routes to the appropriate factory based on connection type:
 * - VIRTUAL: Creates a virtual MCP aggregator client
 * - Local folder (metadata.localDevRoot): Creates an in-process client
 * - STDIO, HTTP, Websocket, SSE: Creates an outbound client
 *
 * @param connection - Connection entity from database
 * @param ctx - Mesh context for creating clients
 * @param superUser - Whether to use superuser mode for background processes
 * @returns Client instance connected to the MCP server
 */
export async function clientFromConnection(
  connection: ConnectionEntity,
  ctx: MeshContext,
  superUser = false,
): Promise<Client> {
  if (connection.connection_type === "VIRTUAL") {
    return createVirtualClient(connection, ctx, superUser);
  }
  // Local filesystem connections — handle in-process (no HTTP round-trip)
  const meta = connection.metadata as { localDevRoot?: string } | null;
  if (meta?.localDevRoot) {
    return createLocalClient(connection, meta.localDevRoot);
  }
  return createOutboundClient(connection, ctx, superUser);
}
