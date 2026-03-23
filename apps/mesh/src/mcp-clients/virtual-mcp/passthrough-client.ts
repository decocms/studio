/**
 * PassthroughClient
 *
 * Base client class that aggregates tools, resources, and prompts from multiple connections.
 * Extends the MCP SDK Client class and provides passthrough behavior for tools.
 * Also supports virtual tools defined on the Virtual MCP itself.
 */

import type { StreamableMCPProxyClient } from "@/api/routes/proxy";
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
import { runCode, type ToolHandler } from "../../sandbox/run-code";
import { getConnectionSlug } from "../../shared/utils/slugify";
import type { ConnectionEntity } from "../../tools/connection/schema";

/** Tool with connection metadata for routing */
interface ToolWithConnection extends Tool {
  _meta: {
    connectionId: string;
    connectionTitle: string;
    originalName?: string;
  };
}
import type { VirtualMCPConnection } from "../../tools/virtual/schema";
import { createLazyClient } from "../lazy-client";
import type { McpListCache } from "../mcp-list-cache";
import type { VirtualClientOptions, VirtualToolDefinition } from "./types";

interface CacheMapping {
  connectionId: string;
  originalName: string;
}

interface Cache<T> {
  data: T[];
  mappings: Map<string, string>; // key -> connectionId
}

/** Cached tool data structure */
interface ToolCache {
  data: ToolWithConnection[];
  mappings: Map<string, CacheMapping>; // namespacedName -> { connectionId, originalName }
  virtualTools: Map<string, VirtualToolDefinition>;
}

/** Cached resource data structure */
interface ResourceCache extends Cache<Resource> {}

/** Cached prompt data structure */
interface PromptCache extends Cache<Prompt> {}

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
      this.options.mcpListCache,
    );

    // Initialize lazy caches - all share the same ProxyCollection
    this._cachedTools = lazy(() => this.loadToolsCache());
    this._cachedResources = lazy(() =>
      this.loadItemsFromClients<Resource>(
        "resources",
        (client) =>
          client
            .listResources()
            .catch(fallbackOnMethodNotFoundError({ resources: [] }))
            .then((r) => r.resources),
        (item) => item.name || item.uri,
        "selected_resources",
        (item) => item.uri,
      ),
    );
    this._cachedPrompts = lazy(() =>
      this.loadItemsFromClients<Prompt>(
        "prompts",
        (client) =>
          client
            .listPrompts()
            .catch(fallbackOnMethodNotFoundError({ prompts: [] }))
            .then((r) => r.prompts),
        (item) => item.name,
        "selected_prompts",
      ),
    );
  }

  /**
   * Generic loader: fan out to all clients, apply selection, flatten with dedup.
   */
  private async loadItemsFromClients<T>(
    type: "tools" | "resources" | "prompts",
    listFn: (client: Client) => Promise<T[]>,
    extractKey: (item: T) => string,
    selectionKey: "selected_tools" | "selected_resources" | "selected_prompts",
    routingKey?: (item: T) => string,
    deduplicate = true,
  ): Promise<Cache<T>> {
    const clients = this._clients;
    const extractRoutingKey = routingKey ?? extractKey;

    const timeoutMs = this.options.listTimeoutMs;

    const results = await Promise.all(
      Array.from(clients.entries()).map(async ([connectionId, client]) => {
        try {
          let dataPromise = listFn(client);

          if (timeoutMs != null) {
            dataPromise = Promise.race([
              dataPromise,
              new Promise<never>((_, reject) =>
                setTimeout(
                  () => reject(new Error(`Timed out after ${timeoutMs}ms`)),
                  timeoutMs,
                ),
              ),
            ]);
          }

          let data = await dataPromise;

          const selected = this._selectionMap.get(connectionId);
          if (selected?.[selectionKey]?.length) {
            const selectedSet = new Set(selected[selectionKey]);
            data = data.filter((item) => selectedSet.has(extractKey(item)));
          }

          return { connectionId, data };
        } catch (error) {
          console.error(
            `[PassthroughClient] Failed to load ${type} for connection ${connectionId}:`,
            error,
          );
          return null;
        }
      }),
    );

    const flattened: T[] = [];
    const mappings = new Map<string, string>();
    const seen = new Set<string>();

    for (const result of results) {
      if (!result) continue;
      const { connectionId, data } = result;
      const connection = this._connections.get(connectionId);
      const connectionTitle = connection?.title ?? "";

      for (const item of data) {
        const rKey = extractRoutingKey(item);
        if (deduplicate && seen.has(rKey)) continue;
        seen.add(rKey);

        (item as any)._meta = {
          connectionId,
          connectionTitle,
          ...(item as any)?._meta,
        };

        flattened.push(item);
        if (deduplicate) {
          mappings.set(rKey, connectionId);
        }
      }
    }

    return { data: flattened, mappings };
  }

  /**
   * Load tools cache from downstream connections plus any virtual tools.
   * Handles tool name collisions by namespacing: `connection-slug::tool_name`
   */
  private async loadToolsCache(): Promise<ToolCache> {
    const virtualToolsMap = new Map<string, VirtualToolDefinition>();
    const virtualItems: ToolWithConnection[] = [];

    for (const virtualTool of this.options.virtualTools ?? []) {
      if (virtualToolsMap.has(virtualTool.name)) continue;
      virtualItems.push({
        ...virtualTool,
        _meta: {
          connectionId: this.options.virtualMcp.id ?? "__VIRTUAL__",
          connectionTitle: this.options.virtualMcp.title,
        },
      });
      virtualToolsMap.set(virtualTool.name, virtualTool);
    }

    // Pass deduplicate=false so tools with the same name from different
    // connections are all preserved — they'll be disambiguated by slug prefix
    const downstream = await this.loadItemsFromClients<ToolWithConnection>(
      "tools",
      (client) =>
        client.listTools().then((r) => r.tools as ToolWithConnection[]),
      (item) => item.name,
      "selected_tools",
      undefined,
      false,
    );

    // Build slug map for connections, disambiguating slug collisions
    const connectionSlugMap = new Map<string, string>();
    const slugToConnIds = new Map<string, string[]>();

    for (const [connId] of this._clients) {
      const connection = this._connections.get(connId);
      if (!connection) continue;
      const slug = getConnectionSlug(connection);
      connectionSlugMap.set(connId, slug);
      const existing = slugToConnIds.get(slug);
      if (existing) {
        existing.push(connId);
      } else {
        slugToConnIds.set(slug, [connId]);
      }
    }

    // Disambiguate slug collisions by appending last 4 chars of connection ID
    for (const [slug, connIds] of slugToConnIds) {
      if (connIds.length > 1) {
        for (const connId of connIds) {
          connectionSlugMap.set(connId, `${slug}-${connId.slice(-4)}`);
        }
      }
    }

    // Build final tool list and mappings — always namespace downstream tools
    const mappings = new Map<string, CacheMapping>();
    const finalTools: ToolWithConnection[] = [];

    // Virtual tools first — always take precedence, never namespaced
    for (const vt of virtualItems) {
      mappings.set(vt.name, {
        connectionId: "__VIRTUAL__",
        originalName: vt.name,
      });
      finalTools.push(vt);
    }

    // Namespace all downstream tools as connection-slug::tool_name
    for (const tool of downstream.data) {
      const connId = (tool as ToolWithConnection)._meta.connectionId;
      const slug = connectionSlugMap.get(connId) ?? connId;
      const originalName = tool.name;
      const namespacedName = `${slug}::${originalName}`;
      const namespacedTool: ToolWithConnection = {
        ...tool,
        name: namespacedName,
        _meta: {
          ...(tool as ToolWithConnection)._meta,
          originalName,
        },
      };
      mappings.set(namespacedName, {
        connectionId: connId,
        originalName,
      });
      finalTools.push(namespacedTool);
    }

    return {
      data: finalTools,
      mappings,
      virtualTools: virtualToolsMap,
    };
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
   * Call a tool by name, routing to the correct connection or executing a
   * virtual tool when the Virtual MCP defines one.
   */
  override async callTool(
    params: CallToolRequest["params"],
  ): Promise<CallToolResult> {
    const cache = await this._cachedTools;
    const clients = this._clients;

    const mapping = cache.mappings.get(params.name);
    if (!mapping) {
      return {
        content: [{ type: "text", text: `Tool not found: ${params.name}` }],
        isError: true,
      };
    }

    if (mapping.connectionId === "__VIRTUAL__") {
      return this.executeVirtualTool(
        params.name,
        params.arguments ?? {},
        cache,
        clients,
      );
    }

    const client = clients.get(mapping.connectionId);
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
      name: mapping.originalName,
      arguments: params.arguments ?? {},
    });

    return result as CallToolResult;
  }

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

    const code = virtualTool._meta["mcp.mesh"]["tool.fn"];
    const toolsRecord: Record<string, ToolHandler> = {};

    // Track which original names are ambiguous (appear in multiple connections)
    const originalNameCount = new Map<string, number>();
    for (const [, mapping] of cache.mappings) {
      if (mapping.connectionId === "__VIRTUAL__") continue;
      originalNameCount.set(
        mapping.originalName,
        (originalNameCount.get(mapping.originalName) ?? 0) + 1,
      );
    }

    for (const [namespacedName, mapping] of cache.mappings) {
      if (mapping.connectionId === "__VIRTUAL__") continue;

      const client = clients.get(mapping.connectionId);
      if (!client) continue;

      const callTool = async (innerArgs: Record<string, unknown>) => {
        const result = await client.callTool({
          name: mapping.originalName,
          arguments: innerArgs,
        });

        if (
          result.structuredContent &&
          typeof result.structuredContent === "object"
        ) {
          return result.structuredContent;
        }

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

      // Always register under the namespaced name (same as plain name if no collision)
      toolsRecord[namespacedName] = callTool;

      // Also register under the original name if it's unambiguous
      const count = originalNameCount.get(mapping.originalName) ?? 0;
      if (count === 1) {
        toolsRecord[mapping.originalName] = callTool;
      }
    }

    try {
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
        timeoutMs: 30000,
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
    const mapping = cache.mappings.get(name);
    if (mapping) {
      const client = clients.get(mapping.connectionId);
      if (client && "callStreamableTool" in client) {
        // Type guard: client has streaming support
        const streamableClient = client as StreamableMCPProxyClient;
        return streamableClient.callStreamableTool(mapping.originalName, args);
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
