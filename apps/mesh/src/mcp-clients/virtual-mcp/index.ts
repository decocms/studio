/**
 * Virtual MCP Client
 *
 * Factory functions for creating MCP clients from Virtual MCP entities.
 * Shared between Virtual MCP routes and proxy routes for VIRTUAL connections.
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { isDecopilot } from "@decocms/mesh-sdk";
import { getMcpListCache } from "../mcp-list-cache";
import type { MeshContext } from "../../core/mesh-context";
import type { ConnectionEntity } from "../../tools/connection/schema";
import type { VirtualMCPEntity } from "../../tools/virtual/schema";
import { PassthroughClient } from "./passthrough-client";
import { type VirtualClientOptions } from "./types";

/**
 * Check if a connection would cause a self-reference for a Virtual MCP
 * (i.e., a VIRTUAL connection that references the same Virtual MCP)
 */
function isSelfReferencingVirtual(
  connection: ConnectionEntity,
  virtualMcpId: string | null,
): boolean {
  if (connection.connection_type !== "VIRTUAL") return false;
  if (!virtualMcpId || isDecopilot(virtualMcpId)) return false; // Decopilot agent can't self-reference
  return connection.id === virtualMcpId;
}

/**
 * Create a virtual MCP client from a connection entity
 *
 * @param connection - Connection entity with VIRTUAL type
 * @param ctx - Mesh context for creating proxies
 * @param superUser - Whether to use superuser mode for background processes
 * @returns Client instance with aggregated tools, resources, and prompts
 */
export async function createVirtualClient(
  connection: ConnectionEntity,
  ctx: MeshContext,
  superUser = false,
): Promise<Client> {
  // Virtual MCP ID is the connection ID
  const virtualMcpId = connection.id;

  // Load virtual MCP entity
  const virtualMcp = await ctx.storage.virtualMcps.findById(virtualMcpId);
  if (!virtualMcp) {
    throw new Error(`Virtual MCP not found: ${virtualMcpId}`);
  }

  // Create client from virtual MCP entity
  return createVirtualClientFrom(virtualMcp, ctx, "passthrough", superUser);
}

/**
 * Load virtual MCP entity and create passthrough MCP client
 * Uses inclusion mode: only connections specified in virtualMcp.connections are included
 *
 * @param virtualMcp - Virtual MCP entity from database
 * @param ctx - Mesh context for creating proxies
 * @param _strategy - Kept for backward compatibility, always uses passthrough
 * @param superUser - Whether to use superuser mode for background processes
 * @returns Client instance with aggregated tools, resources, and prompts
 */
export async function createVirtualClientFrom(
  virtualMcp: VirtualMCPEntity,
  ctx: MeshContext,
  _strategy: "passthrough",
  superUser = false,
): Promise<Client> {
  // Inclusion mode: use only the connections specified in virtual MCP
  const connectionIds = virtualMcp.connections.map((c) => c.connection_id);

  // Load all connections in parallel
  const connectionPromises = connectionIds.map((connId) =>
    ctx.storage.connections.findById(connId),
  );

  const allConnections = await Promise.all(connectionPromises);

  // Filter out inactive connections and self-referencing VIRTUAL connections
  const loadedConnections = allConnections.filter(
    (conn): conn is ConnectionEntity =>
      conn !== null &&
      conn.status === "active" &&
      !isSelfReferencingVirtual(conn, virtualMcp.id),
  );

  // Build aggregator options
  const options: VirtualClientOptions = {
    connections: loadedConnections,
    virtualMcp,
    superUser,
    mcpListCache: getMcpListCache() ?? undefined,
  };

  return new PassthroughClient(options, ctx);
}

// Re-export types and utilities
export { type VirtualClientOptions, type ProxyEntry } from "./types";
