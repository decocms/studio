import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  ErrorCode,
  McpError,
  type ListResourcesResult,
  type ReadResourceResult,
} from "@modelcontextprotocol/sdk/types.js";
import {
  useQuery,
  useSuspenseQuery,
  type UseQueryOptions,
  type UseQueryResult,
  type UseSuspenseQueryOptions,
  type UseSuspenseQueryResult,
} from "@tanstack/react-query";
import { KEYS } from "@/lib/query-keys";
import { resolveStudioUrl } from "../lib/studio-url";

/**
 * List resources from an MCP client.
 * This is the raw async function that can be used outside of React hooks.
 */
export async function listResources(
  client: Client,
): Promise<ListResourcesResult> {
  const capabilities = client.getServerCapabilities();
  if (!capabilities?.resources) {
    return { resources: [] };
  }

  try {
    return await client.listResources();
  } catch (error) {
    if (error instanceof McpError && error.code === ErrorCode.MethodNotFound) {
      return { resources: [] };
    }
    throw error;
  }
}

/**
 * Read a specific resource from an MCP client.
 * This is the raw async function that can be used outside of React hooks.
 */
export async function readResource(
  client: Client,
  uri: string,
): Promise<ReadResourceResult> {
  return await client.readResource({ uri });
}

export interface UseMcpResourcesListOptions
  extends Omit<
    UseSuspenseQueryOptions<ListResourcesResult, Error>,
    "queryKey" | "queryFn"
  > {
  /** The MCP client from useMCPClient */
  client: Client;
}

/**
 * Suspense hook to list resources from an MCP client.
 * Must be used within a Suspense boundary.
 */
export function useMCPResourcesList({
  client,
  ...queryOptions
}: UseMcpResourcesListOptions): UseSuspenseQueryResult<
  ListResourcesResult,
  Error
> {
  return useSuspenseQuery<ListResourcesResult, Error>({
    ...queryOptions,
    queryKey: KEYS.mcpResourcesList(client),
    queryFn: () => listResources(client),
    staleTime: queryOptions.staleTime ?? 30000,
    retry: false,
  });
}

export interface UseMcpResourcesListQueryOptions
  extends Omit<
    UseQueryOptions<ListResourcesResult, Error>,
    "queryKey" | "queryFn"
  > {
  /** The MCP client from useMCPClient */
  client: Client;
}

/**
 * Non-suspense hook to list resources from an MCP client.
 */
export function useMCPResourcesListQuery({
  client,
  ...queryOptions
}: UseMcpResourcesListQueryOptions): UseQueryResult<
  ListResourcesResult,
  Error
> {
  return useQuery<ListResourcesResult, Error>({
    ...queryOptions,
    queryKey: KEYS.mcpResourcesList(client),
    queryFn: () => listResources(client),
    staleTime: queryOptions.staleTime ?? 30000,
    retry: false,
  });
}

export interface UseMcpReadResourceOptions
  extends Omit<
    UseSuspenseQueryOptions<ReadResourceResult, Error>,
    "queryKey" | "queryFn"
  > {
  /** The MCP client from useMCPClient */
  client: Client;
  /** Resource URI to read */
  uri: string;
}

/**
 * Suspense hook to read a specific resource from an MCP client.
 * Must be used within a Suspense boundary.
 */
export function useMCPReadResource({
  client,
  uri,
  ...queryOptions
}: UseMcpReadResourceOptions): UseSuspenseQueryResult<
  ReadResourceResult,
  Error
> {
  return useSuspenseQuery<ReadResourceResult, Error>({
    ...queryOptions,
    queryKey: KEYS.mcpReadResource(client, uri),
    queryFn: () => readResource(client, uri),
    staleTime: queryOptions.staleTime ?? 30000,
    retry: false,
  });
}

/**
 * Query-key discriminator (segment [1]) for cached UI-resource HTML. Exported
 * so a persister can select only these entries — the HTML is large, so it goes
 * to IndexedDB, never the localStorage bootstrap cache.
 */
export const UI_RESOURCE_HTML_KEY = "ui-resource-html" as const;

export interface UseUiResourceHtmlOptions
  extends Omit<UseSuspenseQueryOptions<string, Error>, "queryKey" | "queryFn"> {
  /** Org slug (the `:org` path segment). */
  orgSlug: string;
  /** Connection id serving the resource. */
  connectionId: string;
  /** Resource URI (e.g. `ui://...`). */
  uri: string;
  /** Base Studio URL; defaults to the current origin. */
  studioUrl?: string;
  /** @deprecated Use `studioUrl` instead. */
  meshUrl?: string;
}

/**
 * Read a connection's UI-resource HTML via the cacheable GET endpoint
 * (`/api/:org/mcp/:connectionId/ui-resource`) instead of the JSON-RPC
 * `resources/read` POST. The GET carries an ETag + `Cache-Control`, so the
 * browser HTTP-caches the (often multi-MiB) HTML and revalidates with cheap
 * 304s — and the response is already CSP-injected server-side, ready for an
 * iframe `srcDoc`.
 */
export function useUiResourceHtml({
  orgSlug,
  connectionId,
  uri,
  studioUrl,
  meshUrl,
  ...queryOptions
}: UseUiResourceHtmlOptions): UseSuspenseQueryResult<string, Error> {
  return useSuspenseQuery<string, Error>({
    ...queryOptions,
    queryKey: KEYS.mcpUiResourceHtml(orgSlug, connectionId, uri),
    queryFn: async () => {
      const base = resolveStudioUrl(
        { studioUrl, meshUrl },
        typeof window !== "undefined" ? window.location.origin : "",
      );
      const url = `${base}/api/${encodeURIComponent(
        orgSlug,
      )}/mcp/${encodeURIComponent(
        connectionId,
      )}/ui-resource?uri=${encodeURIComponent(uri)}`;
      const res = await fetch(url, { credentials: "include" });
      if (!res.ok) {
        throw new Error(`Failed to read UI resource (${res.status})`);
      }
      return res.text();
    },
    staleTime: queryOptions.staleTime ?? 30000,
    retry: false,
  });
}
