/**
 * Virtual MCP Types
 *
 * Shared types for virtual MCP client abstractions
 */

import type { ConnectionEntity } from "../../tools/connection/schema";
import type { VirtualMCPEntity } from "../../tools/virtual/schema";
import type { MCPProxyClient } from "../../api/routes/proxy";
import type { McpListCache } from "../../mcp-clients/mcp-list-cache";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";

/** Entry in the proxy map (connection ID -> proxy entry) */
export interface ProxyEntry {
  proxy: MCPProxyClient;
  connection: ConnectionEntity;
}

export interface VirtualToolDefinition
  extends Pick<
    Tool,
    "name" | "description" | "inputSchema" | "outputSchema" | "annotations"
  > {
  _meta: {
    "mcp.mesh": {
      "tool.fn": string;
    };
    connectionDependencies?: string[];
  };
}

/** Options for creating an aggregator */
export interface VirtualClientOptions {
  connections: ConnectionEntity[];
  virtualMcp: VirtualMCPEntity;
  /** Virtual tools defined on this Virtual MCP (tools with code in _meta["mcp.mesh"]["tool.fn"]) */
  virtualTools?: VirtualToolDefinition[];
  /** Whether to use superuser mode for background processes (bypasses auth checks on sub-clients) */
  superUser?: boolean;
  /** Cross-pod NATS KV cache for MCP lists (avoids MCP handshake on listTools/listResources/listPrompts) */
  mcpListCache?: McpListCache;
  /** Per-connection timeout (ms) for list operations (listTools/listResources/listPrompts). Connections that exceed this are skipped. */
  listTimeoutMs?: number;
}
