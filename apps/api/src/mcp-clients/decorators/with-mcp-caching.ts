/**
 * MCP Caching Decorator
 *
 * Adds tool, resource, and prompt list caching to an MCP client.
 * Delegates to fetchWithCache for unified cache-hit/miss + SWR logic.
 * VIRTUAL connections bypass the cache entirely.
 */

import {
  fetchWithCache,
  type McpListCache,
  type McpListType,
} from "../mcp-list-cache";
import type { ConnectionEntity } from "@/tools/connection/schema";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";

const LIST_METHODS = [
  { method: "listTools" as const, type: "tools" as McpListType, key: "tools" },
  {
    method: "listResources" as const,
    type: "resources" as McpListType,
    key: "resources",
  },
  {
    method: "listPrompts" as const,
    type: "prompts" as McpListType,
    key: "prompts",
  },
];

/**
 * listTools/listResources/listPrompts all share this shape; the params/result
 * types differ per-method, so this decorator (which patches all three the same
 * way) treats them uniformly rather than via `any`.
 */
type ListMethodFn = (
  params?: unknown,
  options?: unknown,
) => Promise<Record<string, unknown[]>>;

/**
 * Decorator that adds caching for listTools, listResources, and listPrompts.
 *
 * Delegates to fetchWithCache. VIRTUAL connections bypass cache.
 */
export function withMcpCaching(
  client: Client,
  connection: ConnectionEntity,
  cache?: McpListCache,
): Client {
  const isVirtual = connection.connection_type === "VIRTUAL";
  const shouldBypassCache = (params?: unknown, options?: unknown) =>
    params !== undefined || options !== undefined;

  for (const { method, type, key } of LIST_METHODS) {
    const original = client[method]?.bind(client) as ListMethodFn | undefined;
    if (!original) continue;

    (client as unknown as Record<string, ListMethodFn>)[method] = async (
      params?: unknown,
      options?: unknown,
    ): Promise<Record<string, unknown[]>> => {
      // Bypass cache for VIRTUAL connections or paginated requests
      if (isVirtual || !cache || shouldBypassCache(params, options)) {
        return original(params, options);
      }

      const data = await fetchWithCache(
        type,
        connection.id,
        async () => (await original())[key] ?? [],
        cache,
      );

      return { [key]: data ?? [] };
    };
  }

  return client;
}
