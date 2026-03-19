/**
 * PassthroughClient
 *
 * Base client class that aggregates tools, resources, and prompts from multiple connections.
 * Extends the MCP SDK Client class and provides passthrough behavior for tools.
 * Routes tool calls to the appropriate downstream connection.
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
import type { ConnectionEntity } from "../../tools/connection/schema";

/** Tool with connection metadata for routing */
interface ToolWithConnection extends Tool {
  _meta: {
    connectionId: string;
    connectionTitle: string;
  };
}
import type { VirtualMCPConnection } from "../../tools/virtual/schema";
import { type McpListCache, getMcpListCache } from "../mcp-list-cache";
import type { VirtualClientOptions } from "./types";

interface Cache<T> {
  data: T[];
  mappings: Map<string, string>; // key -> connectionId
}

/** Cached tool data structure */
interface ToolCache extends Cache<ToolWithConnection> {}

/** Cached resource data structure */
interface ResourceCache extends Cache<Resource> {}

/** Cached prompt data structure */
interface PromptCache extends Cache<Prompt> {}

// Module-level revalidation tracking (prevents thundering herd)
const revalidating = new Set<string>();

/**
 * Create a lazy-connecting client wrapper for a connection.
 *
 * If the connection has cached data in NATS KV, `listTools()`, `listResources()`,
 * and `listPrompts()` return cached data immediately (stale-while-revalidate)
 * without establishing an MCP connection. The real client (and its transport +
 * handshake) is only created on the first call that actually needs it.
 *
 * This avoids the ~80-120ms MCP handshake per connection when data is cached.
 */
function createLazyClient(
  connection: ConnectionEntity,
  ctx: MeshContext,
  superUser: boolean,
  cache?: McpListCache,
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

  // SWR helper: return cached data immediately, revalidate in background
  // Only revalidates if realClientPromise already exists (don't create connections just for refresh)
  // Single-flight deduplication via revalidating Set
  const swrList = <T>(
    type: "tools" | "resources" | "prompts",
    listFn: (client: Client) => Promise<T>,
    extractData: (result: T) => unknown[],
  ) => {
    return async (): Promise<T> => {
      if (connection.connection_type !== "VIRTUAL" && cache) {
        const cached = await cache.get(type, connection.id);
        if (cached) {
          // SWR: background revalidation only if real client already exists
          const revalKey = `${type}:${connection.id}`;
          if (realClientPromise && !revalidating.has(revalKey)) {
            revalidating.add(revalKey);
            realClientPromise
              .then((r) => listFn(r))
              .then((r) => cache.set(type, connection.id, extractData(r)))
              .catch(() => {})
              .finally(() => revalidating.delete(revalKey));
          }
          return { [type]: cached } as T;
        }
      }
      // No cached data — must connect
      const real = await getRealClient();
      const result = await listFn(real);
      cache?.set(type, connection.id, extractData(result)).catch(() => {});
      return result;
    };
  };

  placeholder.listTools = swrList(
    "tools",
    (c) => c.listTools(),
    (r) => r.tools,
  );

  placeholder.listResources = swrList(
    "resources",
    (c) => c.listResources(),
    (r) => r.resources,
  );

  placeholder.listPrompts = swrList(
    "prompts",
    (c) => c.listPrompts(),
    (r) => r.prompts,
  );

  // Proxy callTool to the real client (always needs a connection)
  placeholder.callTool = async (params, resultSchema, options) => {
    const real = await getRealClient();
    return real.callTool(params, resultSchema, options);
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
  cache?: McpListCache,
): Map<string, Client> {
  const clientMap = new Map<string, Client>();

  for (const connection of connections) {
    clientMap.set(
      connection.id,
      createLazyClient(connection, ctx, superUser, cache),
    );
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
      getMcpListCache() ?? undefined,
    );

    // Initialize lazy caches - all share the same ProxyCollection
    this._cachedTools = lazy(() => this.loadToolsCache());
    this._cachedResources = lazy(() => this.loadCache("resources"));
    this._cachedPrompts = lazy(() => this.loadCache("prompts"));
  }

  /**
   * Load tools cache from downstream connections
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

    // Add downstream tools
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

    return { data: flattened, mappings };
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
        const transformed = { ...item };

        const key =
          target === "resources"
            ? (transformed.uri ?? transformed.name)
            : (transformed.name ?? transformed.uri);

        if (mappings.has(key)) continue;

        transformed._meta = {
          connectionId,
          connectionTitle,
          ...item?._meta,
        };

        flattened.push(transformed);
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
   * Call a tool by name, routing to the correct connection
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
