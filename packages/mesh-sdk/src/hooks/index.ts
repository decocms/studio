// Collection hooks
export {
  useCollectionItem,
  useCollectionList,
  useCollectionActions,
  buildWhereExpression,
  buildOrderByExpression,
  buildCollectionQueryKey,
  EMPTY_COLLECTION_LIST_RESULT,
  type CollectionEntity,
  type CollectionFilter,
  type UseCollectionListOptions,
  type CollectionQueryKey,
} from "./use-collections";

// Connection hooks
export {
  useConnections,
  useConnection,
  useConnectionActions,
  type ConnectionFilter,
  type UseConnectionsOptions,
} from "./use-connection";

// MCP client hook and factory
export {
  createMCPClient,
  useMCPClient,
  useMCPClientOptional,
  type CreateMcpClientOptions,
  type UseMcpClientOptions,
  type UseMcpClientOptionalOptions,
} from "./use-mcp-client";

// MCP tools hooks
export {
  useMCPToolsList,
  useMCPToolsListQuery,
  useMCPToolCall,
  useMCPToolCallQuery,
  useMCPToolCallMutation,
  type UseMcpToolsListOptions,
  type UseMcpToolsListQueryOptions,
  type UseMcpToolCallOptions,
  type UseMcpToolCallQueryOptions,
  type UseMcpToolCallMutationOptions,
} from "./use-mcp-tools";

// MCP resources hooks and helpers
export {
  listResources,
  readResource,
  useMCPResourcesList,
  useMCPResourcesListQuery,
  useMCPReadResource,
  type UseMcpResourcesListOptions,
  type UseMcpResourcesListQueryOptions,
  type UseMcpReadResourceOptions,
} from "./use-mcp-resources";

// MCP prompts hooks and helpers
export {
  listPrompts,
  getPrompt,
  useMCPPromptsList,
  useMCPPromptsListQuery,
  useMCPGetPrompt,
  type UseMcpPromptsListOptions,
  type UseMcpPromptsListQueryOptions,
  type UseMcpGetPromptOptions,
} from "./use-mcp-prompts";

// Connection install hook
export {
  useConnectionInstall,
  type ConnectionInstallInput,
  type ConnectionInstallOutput,
} from "./use-connection-install";

// Virtual MCP hooks
export {
  useVirtualMCPs,
  useVirtualMCP,
  useVirtualMCPActions,
  type VirtualMCPFilter,
  type UseVirtualMCPsOptions,
} from "./use-virtual-mcp";
