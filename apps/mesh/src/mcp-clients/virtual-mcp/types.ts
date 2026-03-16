/**
 * Virtual MCP Types
 *
 * Shared types for virtual MCP client abstractions
 */

import type { ConnectionEntity } from "../../tools/connection/schema";
import type { VirtualMCPEntity } from "../../tools/virtual/schema";
import type { VirtualToolDefinition } from "../../tools/virtual-tool/schema";
import type { MCPProxyClient } from "../../api/routes/proxy";

/** Entry in the proxy map (connection ID -> proxy entry) */
export interface ProxyEntry {
  proxy: MCPProxyClient;
  connection: ConnectionEntity;
}

/** Options for creating an aggregator */
export interface VirtualClientOptions {
  connections: ConnectionEntity[];
  virtualMcp: VirtualMCPEntity;
  /** Virtual tools defined on this Virtual MCP (tools with code in _meta["mcp.mesh"]["tool.fn"]) */
  virtualTools?: VirtualToolDefinition[];
  /** Whether to use superuser mode for background processes (bypasses auth checks on sub-clients) */
  superUser?: boolean;
}
