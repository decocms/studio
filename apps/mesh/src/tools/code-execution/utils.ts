/**
 * CODE_EXECUTION Shared Utilities
 *
 * Core reusable logic for code execution tools and agent strategies.
 * Used by both:
 * - Management MCP tools (CODE_EXECUTION_*)
 * - Agent query string strategy (?mode=code_execution)
 */

import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import type { MeshContext } from "../../core/mesh-context";
import { requireOrganization } from "../../core/mesh-context";
import type { ProxyEntry } from "../../mcp-clients/virtual-mcp/types";
import { runCode, type RunCodeResult } from "../../sandbox/index";
import type { ConnectionEntity } from "../connection/schema";
import type { VirtualMCPEntity } from "../virtual/schema";

// ============================================================================
// Types
// ============================================================================

/** Extended tool info with connection metadata */
export interface ToolWithConnection extends Tool {
  _meta: {
    connectionId: string;
    connectionTitle: string;
  };
}

/** Connection with tool/resource/prompt selection */
interface ConnectionWithSelection {
  connection: ConnectionEntity;
  selectedTools: string[] | null;
  selectedResources: string[] | null;
  selectedPrompts: string[] | null;
}

/** Context for code execution tools */
export interface ToolContext {
  /** All aggregated tools from connections */
  tools: ToolWithConnection[];
  /** Execute a tool by name (routes to correct connection) */
  callTool: (
    name: string,
    args: Record<string, unknown>,
  ) => Promise<CallToolResult>;
}

/** Tool description for describe tools output */
export interface ToolDescription {
  name: string;
  description?: string;
  connection: string;
  inputSchema: unknown;
  outputSchema?: unknown;
}

// ============================================================================
// Connection Resolution
// ============================================================================

/**
 * Resolve virtual MCP connections (inclusion mode only)
 */
async function resolveVirtualMCPConnections(
  virtualMcp: VirtualMCPEntity,
  ctx: MeshContext,
): Promise<ConnectionWithSelection[]> {
  // Inclusion mode: use only the connections specified in virtual MCP
  const connectionIds = virtualMcp.connections.map((c) => c.connection_id);
  const loadedConnections: ConnectionEntity[] = [];

  for (const connId of connectionIds) {
    const conn = await ctx.storage.connections.findById(connId);
    if (conn && conn.status === "active") {
      loadedConnections.push(conn);
    }
  }

  const connections = loadedConnections.map((conn: ConnectionEntity) => {
    const vmcpConn = virtualMcp.connections.find(
      (c) => c.connection_id === conn.id,
    );
    return {
      connection: conn,
      selectedTools: vmcpConn?.selected_tools ?? null,
      selectedResources: vmcpConn?.selected_resources ?? null,
      selectedPrompts: vmcpConn?.selected_prompts ?? null,
    };
  });

  return connections;
}

/**
 * Get all active connections for an organization
 */
async function getAllOrgConnections(
  organizationId: string,
  ctx: MeshContext,
): Promise<ConnectionWithSelection[]> {
  const allConnections = await ctx.storage.connections.list(organizationId);
  return allConnections
    .filter((c) => c.status === "active")
    .map((connection) => ({
      connection,
      selectedTools: null,
      selectedResources: null,
      selectedPrompts: null,
    }));
}

// ============================================================================
// Tool Loading
// ============================================================================

/**
 * Load tools from connections and create tool context
 */
async function loadToolsFromConnections(
  connections: ConnectionWithSelection[],
  ctx: MeshContext,
): Promise<ToolContext> {
  // Build selection map from connections
  const selectionMap = new Map<string, ConnectionWithSelection>();
  for (const connWithSelection of connections) {
    selectionMap.set(connWithSelection.connection.id, connWithSelection);
  }

  // Extract just the connection entities
  const connectionEntities = connections.map((c) => c.connection);

  // Create proxy map
  const proxyMap = new Map<string, ProxyEntry>();
  const proxyResults = await Promise.allSettled(
    connectionEntities.map(async (connection) => {
      try {
        const proxy = await ctx.createMCPProxy(connection);
        return {
          connection,
          proxy,
        };
      } catch (error) {
        console.warn(
          `[code-execution] Failed to create proxy for connection ${connection.id}:`,
          error,
        );
        return null;
      }
    }),
  );

  for (const result of proxyResults) {
    if (result.status === "fulfilled" && result.value) {
      proxyMap.set(result.value.connection.id, result.value);
    }
  }

  // Fetch tools from all connections in parallel
  const results = await Promise.allSettled(
    Array.from(proxyMap.entries()).map(async ([connectionId, entry]) => {
      try {
        const result = await entry.proxy.listTools();
        let tools = result.tools;

        // Apply inclusion filtering: if selectedTools is specified, filter to only those tools
        const selected = selectionMap.get(connectionId);
        if (selected?.selectedTools && selected.selectedTools.length > 0) {
          const selectedSet = new Set(selected.selectedTools);
          tools = tools.filter((t) => selectedSet.has(t.name));
        }

        return {
          connectionId,
          connectionTitle: entry.connection.title,
          tools,
        };
      } catch (error) {
        console.error(
          `[code-execution] Failed to list tools for connection ${connectionId}:`,
          error,
        );
        return null;
      }
    }),
  );

  // Deduplicate and build tools with connection metadata
  const seenNames = new Set<string>();
  const allTools: ToolWithConnection[] = [];
  const mappings = new Map<string, string>(); // tool name -> connectionId

  for (const result of results) {
    if (result.status !== "fulfilled" || !result.value) continue;

    const { connectionId, connectionTitle, tools } = result.value;

    for (const tool of tools) {
      if (seenNames.has(tool.name)) continue;
      seenNames.add(tool.name);

      allTools.push({
        ...tool,
        _meta: { ...tool._meta, connectionId, connectionTitle },
      });
      mappings.set(tool.name, connectionId);
    }
  }

  // Create base callTool that routes to the correct connection
  const callTool = async (
    name: string,
    args: Record<string, unknown>,
  ): Promise<CallToolResult> => {
    const connectionId = mappings.get(name);
    if (!connectionId) {
      return {
        content: [{ type: "text", text: `Tool not found: ${name}` }],
        isError: true,
      };
    }

    const proxyEntry = proxyMap.get(connectionId);
    if (!proxyEntry) {
      return {
        content: [
          { type: "text", text: `Connection not found for tool: ${name}` },
        ],
        isError: true,
      };
    }

    const result = await proxyEntry.proxy.callTool({
      name,
      arguments: args,
    });

    return result as CallToolResult;
  };

  // Dispose of proxies when done
  const closePromises: Promise<void>[] = [];
  for (const [, entry] of proxyMap) {
    closePromises.push(entry.proxy.close().catch(() => {}));
  }
  await Promise.all(closePromises);

  return {
    tools: allTools,
    callTool,
  };
}

/**
 * Get tools with connections from context
 *
 * If ctx.connectionId is set and points to a VIRTUAL connection (agent),
 * loads that agent's specific connections.
 * Otherwise, loads ALL active connections for the organization.
 */
export async function getToolsWithConnections(
  ctx: MeshContext,
): Promise<ToolContext> {
  const organization = requireOrganization(ctx);

  let connections: ConnectionWithSelection[];

  // Check if we're in a Virtual MCP (agent) context
  if (ctx.connectionId) {
    const virtualMcp = await ctx.storage.virtualMcps.findById(
      ctx.connectionId,
      ctx.organization?.id,
    );
    if (virtualMcp) {
      // connectionId points to a VIRTUAL connection - use its child connections
      connections = await resolveVirtualMCPConnections(virtualMcp, ctx);
    } else {
      // Not a virtual MCP - use all org connections
      connections = await getAllOrgConnections(organization.id, ctx);
    }
  } else {
    // No connection context - use ALL active org connections
    connections = await getAllOrgConnections(organization.id, ctx);
  }

  return loadToolsFromConnections(connections, ctx);
}

// ============================================================================
// Search Tools
// ============================================================================

/**
 * Tokenize search query into terms
 */
function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[\s_\-./]+/)
    .filter((term) => term.length >= 2);
}

/**
 * Calculate relevance score for a tool
 */
function calculateScore(terms: string[], tool: ToolWithConnection): number {
  let score = 0;
  const nameLower = tool.name.toLowerCase();
  const descLower = (tool.description ?? "").toLowerCase();
  const connLower = (tool._meta?.connectionTitle ?? "").toLowerCase();

  for (const term of terms) {
    if (nameLower === term) {
      score += 10;
    } else if (nameLower.includes(term)) {
      score += 3;
    }
    if (descLower.includes(term)) {
      score += 2;
    }
    if (connLower.includes(term)) {
      score += 1;
    }
  }

  return score;
}

/**
 * Search tools by query
 *
 * @param query - Natural language search query
 * @param tools - Tools to search
 * @param limit - Maximum results to return
 * @returns Matching tools sorted by relevance
 */
export function searchTools(
  query: string,
  tools: ToolWithConnection[],
  limit: number,
): ToolWithConnection[] {
  const terms = tokenize(query);

  if (terms.length === 0) {
    return tools.slice(0, limit);
  }

  return tools
    .map((tool) => ({ tool, score: calculateScore(terms, tool) }))
    .filter((r) => r.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((r) => r.tool);
}

// ============================================================================
// Describe Tools
// ============================================================================

/**
 * Get detailed descriptions for specific tools
 *
 * @param names - Tool names to describe
 * @param tools - All available tools
 * @returns Tool descriptions and not found names
 */
export function describeTools(
  names: string[],
  tools: ToolWithConnection[],
): { tools: ToolDescription[]; notFound: string[] } {
  const toolMap = new Map(tools.map((t) => [t.name, t]));

  const foundTools = names
    .map((n) => toolMap.get(n))
    .filter((t): t is ToolWithConnection => t !== undefined);

  return {
    tools: foundTools.map((t) => ({
      name: t.name,
      description: t.description,
      connection: t._meta?.connectionTitle ?? "",
      inputSchema: t.inputSchema,
      outputSchema: t.outputSchema,
    })),
    notFound: names.filter((n) => !toolMap.has(n)),
  };
}

// ============================================================================
// Run Code
// ============================================================================

/**
 * Run JavaScript code with tools in a sandbox
 *
 * @param code - JavaScript ES module code to execute
 * @param toolContext - Tool context with callTool function
 * @param timeoutMs - Execution timeout in milliseconds
 * @returns Run result with return value, error, and console logs
 */
export async function runCodeWithTools(
  code: string,
  toolContext: ToolContext,
  timeoutMs: number,
): Promise<RunCodeResult> {
  // Create tools record for sandbox
  // Extract structured data from CallToolResult so sandbox code can use it directly
  const toolsRecord: Record<
    string,
    (args: Record<string, unknown>) => Promise<unknown>
  > = Object.fromEntries(
    toolContext.tools.map((tool) => [
      tool.name,
      async (innerArgs) => {
        const result = await toolContext.callTool(tool.name, innerArgs ?? {});

        // Prefer structuredContent when available (MCP spec: present when tool defines outputSchema)
        if (
          result.structuredContent &&
          typeof result.structuredContent === "object"
        ) {
          return result.structuredContent;
        }

        // Fall back to extracting from content array
        const content = result.content as
          | Array<{ type: string; text?: string }>
          | undefined;
        if (content?.[0]?.type === "text" && content[0].text) {
          try {
            return JSON.parse(content[0].text);
          } catch {
            return content[0].text;
          }
        }
        return result;
      },
    ]),
  );

  return runCode({
    code,
    tools: toolsRecord,
    timeoutMs,
  });
}

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Create a JSON result for tool output
 */
export function jsonResult(data: unknown): CallToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
  };
}

/**
 * Create a JSON error result for tool output
 */
export function jsonError(data: unknown): CallToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
    isError: true,
  };
}

/**
 * Tool names to exclude from search results when used in agent strategy
 * (to avoid duplication with meta-tools)
 */
const CODE_EXECUTION_TOOL_NAMES = [
  "CODE_EXECUTION_SEARCH_TOOLS",
  "CODE_EXECUTION_DESCRIBE_TOOLS",
  "CODE_EXECUTION_RUN_CODE",
] as const;

/**
 * Filter out CODE_EXECUTION_* tools from search results
 * Used by agent strategy to avoid duplication
 */
export function filterCodeExecutionTools(
  tools: ToolWithConnection[],
): ToolWithConnection[] {
  const excludeSet = new Set<string>(CODE_EXECUTION_TOOL_NAMES);
  return tools.filter((t) => !excludeSet.has(t.name));
}
