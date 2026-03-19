/**
 * MCP Caching Decorator
 *
 * Adds tool, resource, and prompt list caching to an MCP client.
 * Simple cache-read/write layer — no SWR (that lives in createLazyClient).
 * VIRTUAL connections bypass the cache entirely.
 */

import type { McpListCache, McpListType } from "../mcp-list-cache";
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
 * Decorator that adds caching for listTools, listResources, and listPrompts.
 *
 * Checks cache on read, populates on miss. VIRTUAL connections bypass cache.
 */
export function withMcpCaching(
  client: Client,
  connection: ConnectionEntity,
  cache?: McpListCache,
): Client {
  const isVirtual = connection.connection_type === "VIRTUAL";
  const shouldBypassCache = (params?: unknown, options?: unknown) =>
    params !== undefined || options !== undefined;
  const canStoreResult = (result: { nextCursor?: string | undefined }) =>
    result.nextCursor === undefined;

  for (const { method, type, key } of LIST_METHODS) {
    const original = client[method]?.bind(client);
    if (!original) continue;

    (client as any)[method] = async (
      params?: unknown,
      options?: unknown,
    ): Promise<Record<string, unknown>> => {
      if (!isVirtual && cache && !shouldBypassCache(params, options)) {
        const cached = await cache.get(type, connection.id);
        if (cached !== null) {
          return { [key]: cached };
        }
      }

      const result = await (original as any)(params, options);

      if (
        !isVirtual &&
        cache &&
        !shouldBypassCache(params, options) &&
        canStoreResult(result)
      ) {
        cache.set(type, connection.id, (result as any)[key]).catch(() => {});
      }

      return result;
    };
  }

  return client;
}
