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
import { KEYS } from "../lib/query-keys";

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
    queryFn: () =>
      Promise.race([
        readResource(client, uri),
        new Promise<never>((_, reject) =>
          setTimeout(
            () => reject(new Error("Resource load timed out")),
            10_000,
          ),
        ),
      ]),
    staleTime: queryOptions.staleTime ?? 30000,
    retry: false,
  });
}
