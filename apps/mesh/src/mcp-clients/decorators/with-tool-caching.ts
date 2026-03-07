/**
 * Tool Caching Decorator
 *
 * Adds tool list caching to an MCP client by overriding the listTools() method
 * to use indexed tools from the database when available, falling back to the
 * client's listTools() for VIRTUAL connections or when cached tools aren't available.
 */

import type { ToolListCache } from "../tool-list-cache";
import type { ConnectionEntity } from "@/tools/connection/schema";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { ListToolsResult, Tool } from "@modelcontextprotocol/sdk/types.js";

/**
 * Decorator function that adds tool caching to an MCP client
 *
 * This wraps a client's listTools() method to use cached tools from the database
 * when available, improving performance by avoiding downstream calls.
 *
 * @param client - The base MCP client
 * @param connection - The connection entity containing cached tools
 * @returns A client with tool caching enabled
 */
export function withToolCaching(
  client: Client,
  connection: ConnectionEntity,
  cache?: ToolListCache,
): Client {
  // Store original listTools method
  const originalListTools = client.listTools.bind(client);

  // Override listTools with caching logic
  const cachedListTools = async (): Promise<ListToolsResult> => {
    // VIRTUAL connections always use client.listTools() because:
    // 1. Their tools column contains virtual tool definitions (code), not cached downstream tools
    // 2. The aggregator (via client.listTools()) returns virtual + aggregated downstream tools
    const isVirtualConnection = connection.connection_type === "VIRTUAL";

    // Use indexed tools if available (except for VIRTUAL connections)
    if (
      !isVirtualConnection &&
      connection.tools &&
      connection.tools.length > 0
    ) {
      return {
        tools: connection.tools.map((tool) => ({
          name: tool.name,
          description: tool.description,
          inputSchema: tool.inputSchema as Tool["inputSchema"],
          outputSchema: tool.outputSchema as Tool["outputSchema"],
          annotations: tool.annotations,
          _meta: tool._meta,
        })),
      };
    }

    // Check cross-pod cache before hitting the downstream connection
    // VIRTUAL connections are excluded: their tool lists are dynamic and must
    // always be assembled fresh by the aggregator via originalListTools()
    if (!isVirtualConnection && cache) {
      const cached = await cache.get(connection.id);
      if (cached) {
        return { tools: cached };
      }
    }

    // Fall back to client for connections without indexed tools (or VIRTUAL connections)
    const result = await originalListTools();

    // Populate cache so other pods (and next cold start) skip the downstream call
    // VIRTUAL connections are excluded for the same reason as above
    if (!isVirtualConnection && cache && result.tools.length > 0) {
      cache.set(connection.id, result.tools).catch(() => {});
    }

    return result;
  };

  // Override listTools directly on the instance to preserve prototype methods
  // (e.g. getServerCapabilities, getInstructions) which would be lost by spreading
  client.listTools = cachedListTools;
  return client;
}
