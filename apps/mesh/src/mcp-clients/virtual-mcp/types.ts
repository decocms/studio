/**
 * Virtual MCP Types
 *
 * Shared types for virtual MCP client abstractions
 */

import type { ConnectionEntity } from "../../tools/connection/schema";
import type { VirtualMCPEntity } from "../../tools/virtual/schema";
import type { VirtualToolDefinition } from "../../tools/virtual-tool/schema";
import type { MCPProxyClient } from "../../api/routes/proxy";
import type { ToolListCache } from "../../mcp-clients/tool-list-cache";

/** Entry in the proxy map (connection ID -> proxy entry) */
export interface ProxyEntry {
  proxy: MCPProxyClient;
  connection: ConnectionEntity;
}

/**
 * Aggregator tool selection strategy
 * - "passthrough": Pass tools through as-is (default)
 * - "smart_tool_selection": Smart tool selection behavior
 * - "code_execution": Code execution behavior
 */
export type ToolSelectionStrategy =
  | "passthrough"
  | "smart_tool_selection"
  | "code_execution";

/** Options for creating an aggregator */
export interface VirtualClientOptions {
  connections: ConnectionEntity[];
  virtualMcp: VirtualMCPEntity;
  /** Virtual tools defined on this Virtual MCP (tools with code in _meta["mcp.mesh"]["tool.fn"]) */
  virtualTools?: VirtualToolDefinition[];
  /** Whether to use superuser mode for background processes (bypasses auth checks on sub-clients) */
  superUser?: boolean;
  /** Cross-pod NATS KV cache for tool lists (avoids MCP handshake on listTools) */
  toolListCache?: ToolListCache;
}

/**
 * Parse strategy from mode query parameter
 */
export function parseStrategyFromMode(
  mode: string | undefined,
): ToolSelectionStrategy {
  switch (mode) {
    case "smart_tool_selection":
      return "smart_tool_selection";
    case "code_execution":
      return "code_execution";
    case "passthrough":
    default:
      return "passthrough";
  }
}
