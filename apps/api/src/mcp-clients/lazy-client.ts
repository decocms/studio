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
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
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
import {
  appendHintToResult,
  buildValidationHint,
  coerceArgsToSchema,
  enrichInvalidParams,
  invalidParamsResultText,
  type ToolInputSchema,
} from "./validation-hint";

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
 * Cache scope for a connection's read-only results. Defaults to "org" (shared
 * across all members). The per-connection "user" opt-out (key by principal) is
 * a follow-up; the cache already keys by scope, so it's a resolver change only.
 */
function resolveReadCacheScope(): ReadCacheScope {
  return { kind: "org" };
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

  // Dev connections point at an ephemeral sandbox dev server that hot-reloads:
  // never serve its tool lists or ui:// reads from cache, or edits won't show.
  const isDevConnection =
    (connection.metadata as { isDevConnection?: boolean } | null)
      ?.isDevConnection === true;

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
      // Bypass cache for VIRTUAL / dev connections or paginated requests
      if (
        connection.connection_type === "VIRTUAL" ||
        isDevConnection ||
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
  // org-scoped by default and shared across org members. Writes, tools we can't
  // confirm read-only, VIRTUAL connections (they compose other conns), and calls
  // with a custom result schema bypass entirely. `options` (e.g. the timeout) is
  // forwarded to the live fetch but excluded from the cache key.
  // null when MCP caching is disabled (settings-gated).
  const readCache = getMcpReadCache();
  const cacheReads =
    connection.connection_type !== "VIRTUAL" && !isDevConnection;

  const callToolInner: Client["callTool"] = async (
    params,
    resultSchema,
    options,
  ) => {
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
        scope: resolveReadCacheScope(),
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

  // An upstream rejection for -32602 (InvalidParams) happens while validating
  // the arguments, before the tool runs, so it is safe to repair and retry:
  // re-type what the model plainly got wrong and call again, and if it still
  // fails, append a schema-derived correction. Both the thrown and the
  // `isError`-result shapes are handled — see validation-hint.ts. Only the
  // rejection path pays the cached tool-list lookup.
  placeholder.callTool = async (params, resultSchema, options) => {
    const rawName = (params as { name?: unknown })?.name;
    const toolName = typeof rawName === "string" ? rawName : null;
    const args = (params as { arguments?: Record<string, unknown> })?.arguments;

    const inputSchema = async (): Promise<ToolInputSchema | undefined> => {
      const tools = await cache!.get("tools", connection.id).catch(() => null);
      return tools?.find(
        (t): t is { name: string; inputSchema?: ToolInputSchema } =>
          typeof t === "object" &&
          t !== null &&
          (t as { name?: unknown }).name === toolName,
      )?.inputSchema;
    };

    const retryCoerced = async (schema: ToolInputSchema | undefined) => {
      const coerced = coerceArgsToSchema(schema, args);
      if (!coerced) return null;
      return await callToolInner(
        { ...params, arguments: coerced },
        resultSchema,
        options,
      ).catch(() => null);
    };

    let result: Awaited<ReturnType<Client["callTool"]>>;
    try {
      result = await callToolInner(params, resultSchema, options);
    } catch (err) {
      if (
        !toolName ||
        !cache ||
        !(err instanceof McpError) ||
        err.code !== ErrorCode.InvalidParams
      ) {
        throw err;
      }
      const schema = await inputSchema();
      const retried = await retryCoerced(schema);
      if (retried) return retried;
      throw enrichInvalidParams(err, toolName, schema, args);
    }

    if (!toolName || !cache || !invalidParamsResultText(result)) return result;

    const schema = await inputSchema();
    // Accept the retry unless it failed validation again — an ordinary tool
    // error means the coerced arguments were accepted and the tool itself
    // failed, which is the truthful result to return.
    const retried = await retryCoerced(schema);
    if (retried && !invalidParamsResultText(retried)) return retried;

    return appendHintToResult(
      result,
      buildValidationHint(toolName, schema, args),
    );
  };

  placeholder.getPrompt = async (params, options) => {
    if (!readCache || !cacheReads) {
      const real = await getRealClient();
      return real.getPrompt(params, options);
    }
    const result = await readCache.fetch({
      type: "prompts/get",
      connectionId: connection.id,
      scope: resolveReadCacheScope(),
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
      scope: resolveReadCacheScope(),
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
