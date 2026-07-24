// Collection hooks
export {
  useCollectionItem,
  useCollectionActions,
  buildCollectionQueryKey,
  EMPTY_COLLECTION_LIST_RESULT,
  setCollectionToastTranslations,
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
  mcpClientQueryOptions,
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
  type UseMcpToolsListOptions,
  type UseMcpToolsListQueryOptions,
  type UseMcpToolCallOptions,
  type UseMcpToolCallQueryOptions,
} from "./use-mcp-tools";

// MCP resources hooks and helpers
export {
  listResources,
  readResource,
  useMCPResourcesList,
  useMCPResourcesListQuery,
  useMCPReadResource,
  useUiResourceHtml,
  UI_RESOURCE_HTML_KEY,
  type UseMcpResourcesListOptions,
  type UseMcpResourcesListQueryOptions,
  type UseMcpReadResourceOptions,
  type UseUiResourceHtmlOptions,
} from "./use-mcp-resources";

// MCP prompts hooks and helpers
export {
  listPrompts,
  getPrompt,
  useMCPPromptsList,
  useMCPPromptsListQuery,
  type UseMcpPromptsListOptions,
  type UseMcpPromptsListQueryOptions,
} from "./use-mcp-prompts";

// Virtual MCP hooks
export {
  useVirtualMCPs,
  useVirtualMCP,
  useVirtualMCPActions,
  useVirtualMCPsLastUsed,
  type VirtualMCPFilter,
  type UseVirtualMCPsOptions,
  type VirtualMCPLastUsed,
} from "./use-virtual-mcp";
