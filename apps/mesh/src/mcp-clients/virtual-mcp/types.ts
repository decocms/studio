/**
 * Virtual MCP Types
 *
 * Shared types for virtual MCP client abstractions
 */

import type { ConnectionEntity } from "../../tools/connection/schema";
import type { VirtualMCPEntity } from "../../tools/virtual/schema";
import type { MCPProxyClient } from "../../api/routes/proxy";
import type { McpListCache } from "../../mcp-clients/mcp-list-cache";

/** Entry in the proxy map (connection ID -> proxy entry) */
export interface ProxyEntry {
  proxy: MCPProxyClient;
  connection: ConnectionEntity;
}

/** Options for creating an aggregator */
export interface VirtualClientOptions {
  connections: ConnectionEntity[];
  virtualMcp: VirtualMCPEntity;
  /** Whether to use superuser mode for background processes (bypasses auth checks on sub-clients) */
  superUser?: boolean;
  /** Cross-pod NATS KV cache for MCP lists (avoids MCP handshake on listTools/listResources/listPrompts) */
  mcpListCache?: McpListCache;
}
