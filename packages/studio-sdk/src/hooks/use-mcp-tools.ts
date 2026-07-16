import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  useMutation,
  useQuery,
  useSuspenseQuery,
  type UseMutationOptions,
  type UseMutationResult,
  type UseQueryOptions,
  type UseQueryResult,
  type UseSuspenseQueryOptions,
  type UseSuspenseQueryResult,
} from "@tanstack/react-query";
import type {
  CallToolRequest,
  CallToolResult,
  ListToolsResult,
} from "@modelcontextprotocol/sdk/types.js";
import { KEYS } from "../lib/query-keys";

export interface UseMcpToolsListOptions
  extends Omit<
    UseSuspenseQueryOptions<ListToolsResult, Error>,
    "queryKey" | "queryFn"
  > {
  /** The MCP client from useMCPClient */
  client: Client;
}

/**
 * Suspense hook to list tools from an MCP client.
 * Must be used within a Suspense boundary.
 */
export function useMCPToolsList({
  client,
  ...queryOptions
}: UseMcpToolsListOptions): UseSuspenseQueryResult<ListToolsResult, Error> {
  return useSuspenseQuery<ListToolsResult, Error>({
    ...queryOptions,
    queryKey: KEYS.mcpToolsList(client),
    queryFn: async () => {
      return await client.listTools();
    },
    staleTime: queryOptions.staleTime ?? 30000,
    retry: false,
  });
}

export interface UseMcpToolsListQueryOptions
  extends Omit<
    UseQueryOptions<ListToolsResult, Error>,
    "queryKey" | "queryFn"
  > {
  /** The MCP client from useMCPClient */
  client: Client;
}

/**
 * Non-suspense hook to list tools from an MCP client.
 */
export function useMCPToolsListQuery({
  client,
  ...queryOptions
}: UseMcpToolsListQueryOptions): UseQueryResult<ListToolsResult, Error> {
  return useQuery<ListToolsResult, Error>({
    ...queryOptions,
    queryKey: KEYS.mcpToolsList(client),
    queryFn: async () => {
      return await client.listTools();
    },
    staleTime: queryOptions.staleTime ?? 30000,
    retry: false,
  });
}

export interface UseMcpToolCallOptions<TData = CallToolResult>
  extends Omit<
    UseSuspenseQueryOptions<CallToolResult, Error, TData>,
    "queryKey" | "queryFn"
  > {
  /** The MCP client from useMCPClient */
  client: Client;
  /** Tool name to call */
  toolName: string;
  /** Tool arguments */
  toolArguments?: Record<string, unknown>;
}

/**
 * Suspense hook to call a tool on an MCP client.
 * Must be used within a Suspense boundary.
 *
 * @template TData - The type of data returned (after optional select transformation)
 */
export function useMCPToolCall<TData = CallToolResult>({
  client,
  toolName,
  toolArguments,
  ...queryOptions
}: UseMcpToolCallOptions<TData>): UseSuspenseQueryResult<TData, Error> {
  const argsKey = JSON.stringify(toolArguments ?? {});

  return useSuspenseQuery<CallToolResult, Error, TData>({
    ...queryOptions,
    queryKey: KEYS.mcpToolCall(client, toolName, argsKey),
    queryFn: async () => {
      const result = await client.callTool({
        name: toolName,
        arguments: toolArguments,
      });
      return result as CallToolResult;
    },
    staleTime: queryOptions.staleTime ?? 30000,
    retry: false,
  });
}

export interface UseMcpToolCallQueryOptions<TData = CallToolResult>
  extends Omit<
    UseQueryOptions<CallToolResult, Error, TData>,
    "queryKey" | "queryFn"
  > {
  /** The MCP client from useMCPClient */
  client: Client;
  /** Tool name to call */
  toolName: string;
  /** Tool arguments */
  toolArguments?: Record<string, unknown>;
}

/**
 * Non-suspense hook to call a tool on an MCP client.
 *
 * @template TData - The type of data returned (after optional select transformation)
 */
export function useMCPToolCallQuery<TData = CallToolResult>({
  client,
  toolName,
  toolArguments,
  ...queryOptions
}: UseMcpToolCallQueryOptions<TData>): UseQueryResult<TData, Error> {
  const argsKey = JSON.stringify(toolArguments ?? {});

  return useQuery<CallToolResult, Error, TData>({
    ...queryOptions,
    queryKey: KEYS.mcpToolCall(client, toolName, argsKey),
    queryFn: async () => {
      const result = await client.callTool({
        name: toolName,
        arguments: toolArguments,
      });
      return result as CallToolResult;
    },
    staleTime: queryOptions.staleTime ?? 30000,
    retry: false,
  });
}

export interface UseMcpToolCallMutationOptions
  extends Omit<
    UseMutationOptions<CallToolResult, Error, CallToolRequest["params"]>,
    "mutationFn"
  > {
  /** The MCP client from useMCPClient */
  client: Client;
}

/**
 * Mutation hook to call a tool on an MCP client.
 */
export function useMCPToolCallMutation({
  client,
  ...mutationOptions
}: UseMcpToolCallMutationOptions): UseMutationResult<
  CallToolResult,
  Error,
  CallToolRequest["params"]
> {
  return useMutation<CallToolResult, Error, CallToolRequest["params"]>({
    ...mutationOptions,
    mutationFn: async (params) => {
      return (await client.callTool(params)) as CallToolResult;
    },
  });
}
