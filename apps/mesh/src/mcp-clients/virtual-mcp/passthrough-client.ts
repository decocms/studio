/**
 * PassthroughClient
 *
 * Base client class that aggregates tools, resources, and prompts from multiple connections.
 * Extends the MCP SDK Client class and provides passthrough behavior for tools.
 * Also supports virtual tools (JavaScript code defined on the Virtual MCP).
 */

import type { StreamableMCPProxyClient } from "@/api/routes/proxy";
import { clientFromConnection, withStreamingSupport } from "@/mcp-clients";
import { fallbackOnMethodNotFoundError } from "@/mcp-clients/utils";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  type CallToolRequest,
  type CallToolResult,
  type GetPromptRequest,
  type GetPromptResult,
  type ListPromptsResult,
  type ListResourcesResult,
  type ListToolsResult,
  type Prompt,
  type ReadResourceRequest,
  type ReadResourceResult,
  type Resource,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";
import { lazy } from "../../common";
import type { MeshContext } from "../../core/mesh-context";
import { runCode, type ToolHandler } from "../../sandbox/index";
import type { ToolWithConnection } from "../../tools/code-execution/utils";
import type { ConnectionEntity } from "../../tools/connection/schema";
import {
  getVirtualToolCode,
  type VirtualToolDefinition,
} from "../../tools/virtual-tool/schema";
import type { VirtualMCPConnection } from "../../tools/virtual/schema";
import type { VirtualClientOptions } from "./types";

interface Cache<T> {
  data: T[];
  mappings: Map<string, string>; // key -> connectionId
}

/** Cached tool data structure with virtual tool tracking */
interface ToolCache extends Cache<ToolWithConnection> {
  /** Map of virtual tool names to their definitions */
  virtualTools: Map<string, VirtualToolDefinition>;
}

/** Cached resource data structure */
interface ResourceCache extends Cache<Resource> {}

/** Cached prompt data structure */
interface PromptCache extends Cache<Prompt> {}

/**
 * Create a lazy-connecting client wrapper for a connection.
 *
 * If the connection has cached tools in the database, `listTools()` returns
 * them immediately without establishing an MCP connection. The real client
 * (and its transport + handshake) is only created on the first call that
 * actually needs it (e.g. `callTool`).
 *
 * This avoids the ~80-120ms MCP handshake per connection when tools are cached.
 */
function createLazyClient(
  connection: ConnectionEntity,
  ctx: MeshContext,
  superUser: boolean,
): Client {
  // Placeholder client — never connects to anything
  const placeholder = new Client(
    { name: `lazy-${connection.id}`, version: "1.0.0" },
    { capabilities: {} },
  );

  // Shared promise for the real client (single-flight)
  let realClientPromise: Promise<Client> | null = null;

  function getRealClient(): Promise<Client> {
    if (!realClientPromise) {
      realClientPromise = clientFromConnection(connection, ctx, superUser).then(
        (client) => {
          // Apply streaming support for HTTP connections so callStreamableTool
          // can stream responses via direct fetch instead of MCP transport
          if (
            connection.connection_type === "HTTP" ||
            connection.connection_type === "SSE" ||
            connection.connection_type === "Websocket"
          ) {
            return withStreamingSupport(
              client,
              connection.id,
              connection,
              ctx,
              {
                superUser,
              },
            );
          }
          return client;
        },
      );
    }
    return realClientPromise;
  }

  const hasCachedTools =
    connection.connection_type !== "VIRTUAL" &&
    Array.isArray(connection.tools) &&
    connection.tools.length > 0;

  // If cached tools exist, listTools returns them without connecting
  if (hasCachedTools) {
    placeholder.listTools = async () => ({
      tools: connection.tools!.map((tool) => ({
        name: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema as Tool["inputSchema"],
        outputSchema: tool.outputSchema as Tool["outputSchema"],
        annotations: tool.annotations,
        _meta: tool._meta,
      })),
    });
  } else {
    // No cached tools — must connect to get tool list
    placeholder.listTools = async () => {
      const real = await getRealClient();
      return real.listTools();
    };
  }

  // Proxy callTool to the real client (always needs a connection)
  placeholder.callTool = async (params, resultSchema, options) => {
    const real = await getRealClient();
    return real.callTool(params, resultSchema, options);
  };

  // Proxy other methods that need a real connection
  placeholder.listResources = async () => {
    const real = await getRealClient();
    return real.listResources();
  };

  placeholder.listPrompts = async () => {
    const real = await getRealClient();
    return real.listPrompts();
  };

  placeholder.getPrompt = async (params, options) => {
    const real = await getRealClient();
    return real.getPrompt(params, options);
  };

  placeholder.readResource = async (params, options) => {
    const real = await getRealClient();
    return real.readResource(params, options);
  };

  // Proxy callStreamableTool so the `"callStreamableTool" in client` check
  // in PassthroughClient.callStreamableTool() works for lazy clients.
  // The real client may have this method if it's a PassthroughClient (nested
  // virtual MCPs) or if withStreamingSupport was applied.
  (placeholder as any).callStreamableTool = async (
    name: string,
    args: Record<string, unknown>,
  ): Promise<Response> => {
    const real = await getRealClient();
    if (
      "callStreamableTool" in real &&
      typeof (real as any).callStreamableTool === "function"
    ) {
      return (real as any).callStreamableTool(name, args);
    }
    // Fallback: call tool normally and return JSON response
    const result = await real.callTool({ name, arguments: args });
    return new Response(JSON.stringify(result), {
      headers: { "Content-Type": "application/json" },
    });
  };

  // Close the real client if it was ever created
  const originalClose = placeholder.close.bind(placeholder);
  placeholder.close = async () => {
    if (realClientPromise) {
      const real = await realClientPromise.catch(() => null);
      if (real) await real.close().catch(() => {});
    }
    await originalClose();
  };

  return placeholder;
}

/**
 * Create a map of connection ID to client entry
 *
 * Creates lazy-connecting clients for all connections. Clients with cached
 * tools in the database will skip the MCP handshake entirely during tool
 * listing, only connecting when a tool is actually called.
 */
function createClientMap(
  connections: ConnectionEntity[],
  ctx: MeshContext,
  superUser = false,
): Map<string, Client> {
  const clientMap = new Map<string, Client>();

  for (const connection of connections) {
    clientMap.set(connection.id, createLazyClient(connection, ctx, superUser));
  }

  return clientMap;
}

/**
 * Dispose of all clients in a map
 * Closes all clients in parallel, ignoring errors
 */
async function disposeClientMap(clientMap: Map<string, Client>): Promise<void> {
  const closePromises: Promise<void>[] = [];
  for (const [, entry] of clientMap) {
    closePromises.push(entry.close().catch(() => {}));
  }
  await Promise.all(closePromises);
}

/**
 * Base client that aggregates MCP resources from multiple connections.
 * Provides passthrough behavior for tools (exposes all tools directly).
 */
export class PassthroughClient extends Client {
  protected _cachedTools: Promise<ToolCache>;
  protected _cachedResources: Promise<ResourceCache>;
  protected _cachedPrompts: Promise<PromptCache>;
  protected _clients: Map<string, Client>;
  protected _connections: Map<string, ConnectionEntity>;
  protected _selectionMap: Map<string, VirtualMCPConnection>;

  constructor(
    protected options: VirtualClientOptions,
    protected ctx: MeshContext,
  ) {
    super(
      {
        name: "virtual-mcp-passthrough",
        version: "1.0.0",
      },
      {
        capabilities: {
          tasks: {
            list: {},
            cancel: {},
            requests: {
              tool: {
                call: {},
              },
            },
          },
        },
      },
    );

    // Build selection map from options.virtualMcp.connections
    this._selectionMap = new Map();
    for (const selected of options.virtualMcp.connections) {
      this._selectionMap.set(selected.connection_id, selected);
    }

    this._connections = new Map<string, ConnectionEntity>();
    for (const connection of options.connections) {
      this._connections.set(connection.id, connection);
    }

    // Create lazy-connecting client map (synchronous — no connections established yet)
    this._clients = createClientMap(
      this.options.connections,
      this.ctx,
      this.options.superUser,
    );

    // Initialize lazy caches - all share the same ProxyCollection
    this._cachedTools = lazy(() => this.loadToolsCache());
    this._cachedResources = lazy(() => this.loadCache("resources"));
    this._cachedPrompts = lazy(() => this.loadCache("prompts"));
  }

  /**
   * Load tools cache including virtual tools
   */
  private async loadToolsCache(): Promise<ToolCache> {
    const clients = this._clients;

    const results = await Promise.all(
      Array.from(clients.entries()).map(async ([connectionId, client]) => {
        try {
          let data = await client.listTools().then((r) => r.tools);

          const selected = this._selectionMap.get(connectionId);
          if (selected?.selected_tools?.length) {
            const selectedSet = new Set(selected.selected_tools);
            data = data.filter((item) => selectedSet.has(item.name));
          }

          return { connectionId, data };
        } catch (error) {
          console.error(
            `[PassthroughClient] Failed to load tools for connection ${connectionId}:`,
            error,
          );
          return null;
        }
      }),
    );

    const flattened: ToolWithConnection[] = [];
    const mappings = new Map<string, string>();
    const virtualToolsMap = new Map<string, VirtualToolDefinition>();

    // First, add virtual tools (they take precedence)
    const virtualTools = this.options.virtualTools ?? [];
    for (const virtualTool of virtualTools) {
      if (mappings.has(virtualTool.name)) continue;

      // Convert virtual tool to Tool format for listing
      const tool: ToolWithConnection = {
        name: virtualTool.name,
        description: virtualTool.description,
        inputSchema: virtualTool.inputSchema as Tool["inputSchema"],
        outputSchema: virtualTool.outputSchema as Tool["outputSchema"],
        annotations: virtualTool.annotations,
        _meta: {
          connectionId: this.options.virtualMcp.id ?? "__VIRTUAL__",
          connectionTitle: this.options.virtualMcp.title,
        },
      };

      flattened.push(tool);
      mappings.set(virtualTool.name, "__VIRTUAL__"); // Special marker for virtual tools
      virtualToolsMap.set(virtualTool.name, virtualTool);
    }

    // Then add downstream tools
    for (const result of results) {
      if (!result) continue;

      const { connectionId, data } = result;
      const connection = this._connections.get(connectionId);
      const connectionTitle = connection?.title ?? "";

      for (const item of data) {
        const key = item.name;

        if (mappings.has(key)) continue;

        const transformedItem: ToolWithConnection = {
          ...item,
          _meta: {
            connectionId,
            connectionTitle,
            ...item?._meta,
          },
        };

        flattened.push(transformedItem);
        mappings.set(key, connectionId);
      }
    }

    return { data: flattened, mappings, virtualTools: virtualToolsMap };
  }

  private async loadCache<T>(
    target: "resources" | "prompts",
  ): Promise<Cache<T>> {
    const clients = this._clients;

    const results = await Promise.all(
      Array.from(clients.entries()).map(async ([connectionId, client]) => {
        try {
          const data =
            target === "resources"
              ? await client
                  .listResources()
                  .catch(fallbackOnMethodNotFoundError({ resources: [] }))
                  .then((r) => r.resources)
              : await client
                  .listPrompts()
                  .catch(fallbackOnMethodNotFoundError({ prompts: [] }))
                  .then((r) => r.prompts);

          const selected = this._selectionMap.get(connectionId);
          const selectedKey =
            target === "resources" ? "selected_resources" : "selected_prompts";
          if (selected?.[selectedKey]?.length) {
            const selectedSet = new Set(selected[selectedKey]);
            return {
              connectionId,
              data: data.filter((item: any) => selectedSet.has(item.name)),
            };
          }

          return { connectionId, data };
        } catch (error) {
          console.error(
            `[PassthroughClient] Failed to load cache for connection ${connectionId}:`,
            error,
          );
          return null;
        }
      }),
    );

    const flattened: T[] = [];
    const mappings = new Map<string, string>();

    for (const result of results) {
      if (!result) continue;

      const { connectionId, data } = result;
      const connection = this._connections.get(connectionId);
      const connectionTitle = connection?.title ?? "";

      for (const item of data as any[]) {
        const key = item.name ?? item.uri;

        if (mappings.has(key)) continue;

        const transformedItem = {
          ...item,
          _meta: {
            connectionId,
            connectionTitle,
            ...item?._meta,
          },
        };

        flattened.push(transformedItem);
        mappings.set(key, connectionId);
      }
    }

    return { data: flattened, mappings };
  }

  /**
   * List all aggregated tools (passthrough - exposes all tools directly)
   */
  override async listTools(): Promise<ListToolsResult> {
    const cache = await this._cachedTools;
    return {
      tools: cache.data,
    };
  }

  /**
   * Call a tool by name, routing to the correct connection or executing virtual tool code
   */
  override async callTool(
    params: CallToolRequest["params"],
  ): Promise<CallToolResult> {
    const cache = await this._cachedTools;
    const clients = this._clients;

    const connectionId = cache.mappings.get(params.name);
    if (!connectionId) {
      return {
        content: [{ type: "text", text: `Tool not found: ${params.name}` }],
        isError: true,
      };
    }

    // Check if this is a virtual tool
    if (connectionId === "__VIRTUAL__") {
      return this.executeVirtualTool(
        params.name,
        params.arguments ?? {},
        cache,
        clients,
      );
    }

    const client = clients.get(connectionId);
    if (!client) {
      return {
        content: [
          {
            type: "text",
            text: `Connection not found for tool: ${params.name}`,
          },
        ],
        isError: true,
      };
    }

    const result = await client.callTool({
      name: params.name,
      arguments: params.arguments ?? {},
    });

    return result as CallToolResult;
  }

  /**
   * Execute a virtual tool by running its JavaScript code in the sandbox
   */
  private async executeVirtualTool(
    toolName: string,
    args: Record<string, unknown>,
    cache: ToolCache,
    clients: Map<string, Client>,
  ): Promise<CallToolResult> {
    const virtualTool = cache.virtualTools.get(toolName);
    if (!virtualTool) {
      return {
        content: [
          { type: "text", text: `Virtual tool not found: ${toolName}` },
        ],
        isError: true,
      };
    }

    const code = getVirtualToolCode(virtualTool);

    // Build tools record for the sandbox
    // This allows virtual tool code to call downstream tools via `tools.TOOL_NAME(args)`
    const toolsRecord: Record<string, ToolHandler> = {};

    for (const [name, connId] of cache.mappings) {
      // Skip virtual tools in the tools record (they can't call other virtual tools)
      if (connId === "__VIRTUAL__") continue;

      const client = clients.get(connId);
      if (!client) continue;

      toolsRecord[name] = async (innerArgs: Record<string, unknown>) => {
        const result = await client.callTool({
          name,
          arguments: innerArgs,
        });

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
      };
    }

    try {
      // The virtual tool code format: `export default async (tools, args) => { ... }`
      // We strip `export default` and wrap it to inject args
      const strippedCode = code.replace(/^\s*export\s+default\s+/, "").trim();

      const wrappedCode = `
        const __virtualToolFn = ${strippedCode};
        export default async (tools) => {
          const args = ${JSON.stringify(args)};
          return await __virtualToolFn(tools, args);
        };
      `;

      const result = await runCode({
        code: wrappedCode,
        tools: toolsRecord,
        timeoutMs: 30000, // 30 second timeout for virtual tools
      });

      if (result.error) {
        return {
          content: [
            {
              type: "text",
              text: `Virtual tool error: ${result.error}`,
            },
          ],
          isError: true,
        };
      }

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(result.returnValue ?? null),
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Virtual tool execution failed: ${error instanceof Error ? error.message : String(error)}`,
          },
        ],
        isError: true,
      };
    }
  }

  /**
   * List all aggregated resources
   */
  override async listResources(): Promise<ListResourcesResult> {
    const cache = await this._cachedResources;
    return { resources: cache.data };
  }

  /**
   * Read a resource by URI, routing to the correct connection
   */
  override async readResource(
    params: ReadResourceRequest["params"],
  ): Promise<ReadResourceResult> {
    const cache = await this._cachedResources;
    const clients = this._clients;

    const connectionId = cache.mappings.get(params.uri);
    if (!connectionId) {
      throw new Error(`Resource not found: ${params.uri}`);
    }

    const client = clients.get(connectionId);
    if (!client) {
      throw new Error(`Connection not found for resource: ${params.uri}`);
    }

    return await client.readResource(params);
  }

  /**
   * List all aggregated prompts
   */
  override async listPrompts(): Promise<ListPromptsResult> {
    const cache = await this._cachedPrompts;
    return { prompts: cache.data };
  }

  /**
   * Get a prompt by name, routing to the correct connection
   */
  override async getPrompt(
    params: GetPromptRequest["params"],
  ): Promise<GetPromptResult> {
    const cache = await this._cachedPrompts;
    const clients = this._clients;

    const connectionId = cache.mappings.get(params.name);
    if (!connectionId) {
      throw new Error(`Prompt not found: ${params.name}`);
    }

    const client = clients.get(connectionId);
    if (!client) {
      throw new Error(`Connection not found for prompt: ${params.name}`);
    }

    return await client.getPrompt(params);
  }

  /**
   * Call a tool with streaming support
   */
  async callStreamableTool(
    name: string,
    args: Record<string, unknown>,
  ): Promise<Response> {
    const cache = await this._cachedTools;
    const clients = this._clients;

    // For direct tools, route to underlying proxy for streaming
    const connectionId = cache.mappings.get(name);
    if (connectionId) {
      const client = clients.get(connectionId);
      if (client && "callStreamableTool" in client) {
        // Type guard: client has streaming support
        const streamableClient = client as StreamableMCPProxyClient;
        return streamableClient.callStreamableTool(name, args);
      }
    }

    // Meta-tool or not found - execute through callTool and return JSON
    const result = await this.callTool({ name, arguments: args });
    return new Response(JSON.stringify(result), {
      headers: { "Content-Type": "application/json" },
    });
  }

  /**
   * Dispose of all clients in the collection
   */
  async [Symbol.asyncDispose](): Promise<void> {
    await disposeClientMap(this._clients);
  }

  /**
   * Close the client and dispose of all clients
   */
  override async close(): Promise<void> {
    await disposeClientMap(this._clients);
    await super.close();
  }

  /**
   * Get server instructions from virtual MCP metadata
   */
  override getInstructions(): string | undefined {
    return this.options.virtualMcp.metadata?.instructions ?? undefined;
  }
}
