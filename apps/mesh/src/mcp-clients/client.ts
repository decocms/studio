/**
 * MCP Client Factory
 *
 * Top-level factory for creating MCP clients from connection entities.
 * Routes to appropriate factory based on connection type.
 */

import type { MeshContext } from "@/core/mesh-context";
import type { ConnectionEntity } from "@/tools/connection/schema";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { managementMCP } from "@/tools";
import { createOutboundClient } from "./outbound";
import { createVirtualClient } from "./virtual-mcp";

/**
 * Build an in-process MCP client backed by an MCP Server (already
 * registered with tools). Avoids an HTTP roundtrip for pseudo-connections
 * that are hosted in this same process — notably the SELF management MCP,
 * whose stored URL points at the configured BASE_URL (e.g. a `*.localhost`
 * proxy hostname in dev) that Bun's fetch on macOS cannot resolve.
 */
async function connectInProcess(
  server: Awaited<ReturnType<typeof managementMCP>>,
  name: string,
): Promise<Client> {
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name, version: "1.0.0" }, { capabilities: {} });
  await client.connect(clientTransport);
  return client;
}

/**
 * Create an MCP client from a connection entity
 *
 * Routes to the appropriate factory based on connection type:
 * - SELF pseudo-connections (`<orgId>_self`): In-process management MCP
 * - VIRTUAL: Creates a virtual MCP aggregator client
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
  if (connection.id.endsWith("_self")) {
    return connectInProcess(await managementMCP(ctx), "self-in-process");
  }
  if (connection.connection_type === "VIRTUAL") {
    return createVirtualClient(connection, ctx, superUser);
  }
  return createOutboundClient(connection, ctx, superUser);
}
