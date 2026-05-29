/**
 * Lazy-connecting MCP Client
 *
 * Creates a placeholder Client that defers the actual MCP connection until
 * it is needed. For list operations (tools, resources, prompts), cached data
 * from NATS KV is returned immediately via fetchWithCache — the real client
 * (and its ~80-120ms handshake) is only created on a cache miss or when a
 * non-list operation (callTool, readResource, etc.) is invoked.
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { RequestOptions } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type {
  GetPromptResult,
  ListPromptsRequest,
  ListPromptsResult,
  ListResourcesRequest,
  ListResourcesResult,
  ListToolsRequest,
  ListToolsResult,
  ReadResourceResult,
} from "@modelcontextprotocol/sdk/types.js";
import type { MeshContext } from "../core/mesh-context";
import type { ConnectionEntity } from "../tools/connection/schema";
import {
  assertCircuitClosed,
  recordFailure,
  recordSuccess,
} from "./circuit-breaker";
import { clientFromConnection } from "./client";
import { fetchWithCache, type McpListCache } from "./mcp-list-cache";
import { getMcpReadCache } from "./mcp-read-cache";

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
export function createLazyClient(
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
    // Fast-fail if the circuit breaker is open for this connection
    assertCircuitClosed(connection.id);

    if (!realClientPromise) {
      realClientPromise = clientFromConnection(connection, ctx, superUser)
        .then((client) => {
          recordSuccess(connection.id);
          return client;
        })
        .catch((err) => {
          // Clear cached promise so transient failures don't permanently
          // break the client — next call will retry the connection.
          realClientPromise = null;
          recordFailure(connection.id);
          throw err;
        });
    }
    return realClientPromise;
  }

  const shouldBypassCache = (params?: unknown, options?: unknown) =>
    params !== undefined || options !== undefined;

  // SWR helper: delegates to fetchWithCache for cache-hit/miss logic.
  // VIRTUAL connections and paginated requests bypass the cache entirely.
  const swrList = <T extends { nextCursor?: string | undefined }>(
    type: "tools" | "resources" | "prompts",
    listFn: (
      client: Client,
      params?: unknown,
      options?: RequestOptions,
    ) => Promise<T>,
    extractData: (result: T) => unknown[],
    buildCachedResult: (cached: unknown[]) => T,
  ) => {
    return async (params?: unknown, options?: RequestOptions): Promise<T> => {
      // Bypass cache for VIRTUAL connections or paginated requests
      if (
        connection.connection_type === "VIRTUAL" ||
        !cache ||
        shouldBypassCache(params, options)
      ) {
        const real = await getRealClient();
        return listFn(real, params, options);
      }

      const result = await fetchWithCache(
        type,
        connection.id,
        async () => {
          const real = await getRealClient();
          const res = await listFn(real);
          return extractData(res);
        },
        cache,
        (p) => ctx.pendingRevalidations.push(p),
      );

      return buildCachedResult(result ?? []);
    };
  };

  placeholder.listTools = swrList(
    "tools",
    (c, params, options) =>
      c.listTools(params as ListToolsRequest["params"] | undefined, options),
    (r) => r.tools,
    (cached) => ({ tools: cached as ListToolsResult["tools"] }),
  );

  placeholder.listResources = swrList(
    "resources",
    (c, params, options) =>
      c.listResources(
        params as ListResourcesRequest["params"] | undefined,
        options,
      ),
    (r) => r.resources,
    (cached) => ({ resources: cached as ListResourcesResult["resources"] }),
  );

  placeholder.listPrompts = swrList(
    "prompts",
    (c, params, options) =>
      c.listPrompts(
        params as ListPromptsRequest["params"] | undefined,
        options,
      ),
    (r) => r.prompts,
    (cached) => ({ prompts: cached as ListPromptsResult["prompts"] }),
  );

  // Proxy non-list operations to the real client (always needs a connection)
  placeholder.callTool = async (params, resultSchema, options) => {
    const real = await getRealClient();
    return real.callTool(params, resultSchema, options);
  };

  // Read-content cache (resources/read, prompts/get): per-pod TTL+LRU, shared
  // across org members. VIRTUAL connections bypass (they compose other conns).
  const readCache = getMcpReadCache();
  const cacheReads = connection.connection_type !== "VIRTUAL";

  placeholder.getPrompt = async (params, options) => {
    if (cacheReads) {
      const hit = readCache.get("prompts/get", connection.id, params);
      if (hit !== null) return hit as GetPromptResult;
    }
    const real = await getRealClient();
    const result = await real.getPrompt(params, options);
    if (cacheReads) {
      readCache.set("prompts/get", connection.id, params, result);
    }
    return result;
  };

  placeholder.readResource = async (params, options) => {
    if (cacheReads) {
      const hit = readCache.get("resources/read", connection.id, params);
      if (hit !== null) return hit as ReadResourceResult;
    }
    const real = await getRealClient();
    const result = await real.readResource(params, options);
    if (cacheReads) {
      readCache.set("resources/read", connection.id, params, result);
    }
    return result;
  };

  placeholder.listResourceTemplates = async (params, options) => {
    const real = await getRealClient();
    return real.listResourceTemplates(params, options);
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
