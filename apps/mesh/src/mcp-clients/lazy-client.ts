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
import { sharedJsonSchemaValidator } from "@decocms/mcp-utils";
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
import type { StudioContext } from "../core/studio-context";
import type { ConnectionEntity } from "../tools/connection/schema";
import {
  assertCircuitClosed,
  recordFailure,
  recordSuccess,
} from "./circuit-breaker";
import { clientFromConnection } from "./client";
import { invalidateConnectionCaches } from "./mcp-cache-invalidation";
import {
  fetchWithCache,
  type McpListCache,
  REVALIDATE_MIN_INTERVAL_MS,
} from "./mcp-list-cache";
import { getMcpReadCache, type ReadCacheScope } from "./mcp-read-cache";

/**
 * A read-only tool is eligible for result caching. We trust the upstream's
 * `annotations.readOnlyHint` (surfaced in the cached tool list); a tool we
 * can't confirm read-only is never cached.
 */
async function isReadOnlyTool(
  cache: McpListCache | undefined,
  connectionId: string,
  toolName: string,
): Promise<boolean> {
  if (!cache) return false;
  const tools = await cache.get("tools", connectionId).catch(() => null);
  if (!tools) return false;
  for (const t of tools) {
    if (
      typeof t === "object" &&
      t !== null &&
      (t as { name?: unknown }).name === toolName
    ) {
      return (
        (t as { annotations?: { readOnlyHint?: boolean } }).annotations
          ?.readOnlyHint === true
      );
    }
  }
  return false;
}

/**
 * Cache scope for a connection's read-only results.
 *
 * Keyed by the calling principal whenever there is one, so a result that
 * depends on the caller's identity — anything that reads the forwarded
 * `x-mesh-token`, e.g. a per-user auth/access check — is never served to a
 * different user. Studio can't tell which upstream reads vary by caller, so
 * per-user is the only safe default: org-shared caching would leak the first
 * caller's result to the whole org for up to `maxStaleMs`. A single user's
 * repeated reads still hit the cache (the dominant dashboard-polling case);
 * only cross-user sharing of identity-independent reads is given up.
 *
 * Falls back to "org" only when there is no principal at all (e.g. a
 * super-user background worker with no app user), where there is no per-user
 * identity to leak.
 */
export function resolveReadCacheScope(
  principalId: string | undefined,
): ReadCacheScope {
  return principalId ? { kind: "user", userId: principalId } : { kind: "org" };
}

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
  ctx: StudioContext,
  superUser: boolean,
  cache?: McpListCache,
): Client {
  // Placeholder client — never connects to anything
  const placeholder = new Client(
    { name: `lazy-${connection.id}`, version: "1.0.0" },
    { capabilities: {}, jsonSchemaValidator: sharedJsonSchemaValidator },
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
        REVALIDATE_MIN_INTERVAL_MS,
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

  // Read-only results (tools/call for read-only tools, resources/read,
  // prompts/get) are served stale-while-revalidate from the per-pod read cache,
  // scoped per calling principal by default (see resolveReadCacheScope). Writes,
  // tools we can't confirm read-only, VIRTUAL connections (they compose other
  // conns), and calls with a custom result schema bypass entirely. `options`
  // (e.g. the timeout) is forwarded to the live fetch but excluded from the key.
  // null when MCP caching is disabled (settings-gated).
  const readCache = getMcpReadCache();
  const cacheReads = connection.connection_type !== "VIRTUAL";
  // Resolved once from the per-request ctx: the lazy client is created per
  // request, so this is the actual caller, not a stale connection-time identity.
  const readCacheScope = resolveReadCacheScope(
    ctx.auth?.user?.id ?? ctx.auth?.apiKey?.userId,
  );

  placeholder.callTool = async (params, resultSchema, options) => {
    const toolName = (params as { name?: unknown })?.name;
    const readOnly =
      cacheReads &&
      typeof toolName === "string" &&
      (await isReadOnlyTool(cache, connection.id, toolName));

    // Read-only tools are served stale-while-revalidate from the per-pod read
    // cache (when caching is enabled). A custom result schema bypasses caching
    // (the value is reshaped).
    if (readCache && readOnly && !resultSchema) {
      const result = await readCache.fetch({
        type: "tools/call",
        connectionId: connection.id,
        scope: readCacheScope,
        params: {
          name: toolName,
          arguments: (params as { arguments?: unknown })?.arguments,
        },
        fetchLive: async () => {
          const real = await getRealClient();
          return real.callTool(params, resultSchema, options);
        },
        // Never cache error results — returned to the caller but not stored.
        shouldCache: (value) =>
          (value as { isError?: boolean })?.isError !== true,
        onRevalidation: (p) => ctx.pendingRevalidations.push(p),
      });
      return result as Awaited<ReturnType<Client["callTool"]>>;
    }

    const real = await getRealClient();

    // Any tool we can't confirm read-only is treated as a mutation: after the
    // call, evict this connection's cached read results on every replica so the
    // next read sees fresh data. Invalidate even on throw — a partial mutation
    // may have landed. Only when caching is enabled (readCache present) and the
    // connection caches reads; VIRTUAL connections route through the upstream
    // connections' own lazy clients, which invalidate themselves.
    if (readCache && cacheReads && !readOnly) {
      try {
        return await real.callTool(params, resultSchema, options);
      } finally {
        invalidateConnectionCaches(connection.id);
      }
    }

    return real.callTool(params, resultSchema, options);
  };

  placeholder.getPrompt = async (params, options) => {
    if (!readCache || !cacheReads) {
      const real = await getRealClient();
      return real.getPrompt(params, options);
    }
    const result = await readCache.fetch({
      type: "prompts/get",
      connectionId: connection.id,
      scope: readCacheScope,
      params,
      fetchLive: async () => {
        const real = await getRealClient();
        return real.getPrompt(params, options);
      },
      onRevalidation: (p) => ctx.pendingRevalidations.push(p),
    });
    return result as GetPromptResult;
  };

  placeholder.readResource = async (params, options) => {
    if (!readCache || !cacheReads) {
      if (process.env?.MCP_CACHE_DEBUG) {
        console.log(
          "[mcp-read-cache] BYPASS (VIRTUAL)",
          connection.id,
          "resources/read",
        );
      }
      const real = await getRealClient();
      return real.readResource(params, options);
    }
    const result = await readCache.fetch({
      type: "resources/read",
      connectionId: connection.id,
      scope: readCacheScope,
      params,
      fetchLive: async () => {
        const real = await getRealClient();
        return real.readResource(params, options);
      },
      onRevalidation: (p) => ctx.pendingRevalidations.push(p),
    });
    return result as ReadResourceResult;
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
