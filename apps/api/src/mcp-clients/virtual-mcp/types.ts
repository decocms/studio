/**
 * Virtual MCP Types
 *
 * Shared types for virtual MCP client abstractions
 */

import type { ConnectionEntity } from "../../tools/connection/schema";
import type { VirtualMCPEntity } from "../../tools/virtual/schema";
import type { McpListCache } from "../../mcp-clients/mcp-list-cache";

/** Options for creating an aggregator */
export interface VirtualClientOptions {
  connections: ConnectionEntity[];
  /**
   * Persisted agent configuration. Concrete-connection subagents omit this:
   * they use the same gateway over one connection with an ephemeral identity.
   */
  virtualMcp?: VirtualMCPEntity;
  /** Instructions for an ephemeral, connection-scoped subagent. */
  instructions?: string;
  /** Whether to use superuser mode for background processes (bypasses auth checks on sub-clients) */
  superUser?: boolean;
  /** Cross-pod NATS KV cache for MCP lists (avoids MCP handshake on listTools/listResources/listPrompts) */
  mcpListCache?: McpListCache;
  /** Per-connection timeout (ms) for list operations (listTools/listResources/listPrompts). Connections that exceed this are skipped. */
  listTimeoutMs?: number;
  /**
   * Pre-rendered `<available-skills>` catalog block, appended to the served
   * instructions by `getInstructions()`. Built async in the factory (the sync
   * `getInstructions()` can't read org-fs) so it reaches both the in-process
   * cluster engine and the sandbox/desktop daemon. Only set for agent runtimes.
   */
  skillsBlock?: string;
}
