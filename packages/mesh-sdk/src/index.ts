// Context
export {
  ProjectContextProvider,
  useProjectContext,
  useOrg,
  useCurrentProject,
  useIsOrgAdmin,
  Locator,
  type ProjectContextProviderProps,
  type ProjectLocator,
  type LocatorStructured,
  type OrganizationData,
  type ProjectData,
  type ProjectUI,
} from "./context";

// Hooks
export {
  // Collection hooks
  useCollectionItem,
  useCollectionList,
  useCollectionListAsync,
  useCollectionActions,
  buildWhereExpression,
  buildOrderByExpression,
  buildCollectionQueryKey,
  EMPTY_COLLECTION_LIST_RESULT,
  type CollectionEntity,
  type CollectionFilter,
  type UseCollectionListOptions,
  type CollectionQueryKey,
  // Connection hooks
  useConnections,
  useConnectionsAsync,
  useConnectionsInfinite,
  useConnection,
  useConnectionActions,
  type ConnectionFilter,
  type UseConnectionsOptions,
  // MCP client hook and factory
  createMCPClient,
  useMCPClient,
  useMCPClientOptional,
  type CreateMcpClientOptions,
  type UseMcpClientOptions,
  type UseMcpClientOptionalOptions,
  // MCP tools hooks
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
  // MCP resources hooks and helpers
  listResources,
  readResource,
  useMCPResourcesList,
  useMCPResourcesListQuery,
  useMCPReadResource,
  type UseMcpResourcesListOptions,
  type UseMcpResourcesListQueryOptions,
  type UseMcpReadResourceOptions,
  // MCP prompts hooks and helpers
  listPrompts,
  getPrompt,
  useMCPPromptsList,
  useMCPPromptsListQuery,
  useMCPGetPrompt,
  type UseMcpPromptsListOptions,
  type UseMcpPromptsListQueryOptions,
  type UseMcpGetPromptOptions,
  // Virtual MCP hooks
  useVirtualMCPs,
  useVirtualMCP,
  useVirtualMCPActions,
  type VirtualMCPFilter,
  type UseVirtualMCPsOptions,
} from "./hooks";

// Types
export {
  // AI Provider types
  PROVIDER_IDS,
  MODEL_CAPABILITIES,
  type ProviderId,
  type ModelCapability,
  type AiProviderModel,
  type AiProviderModelLimits,
  type AiProviderModelCosts,
  type AiProviderKey,
  type AiProviderInfo,
  // Connection types
  ConnectionEntitySchema,
  ConnectionCreateDataSchema,
  ConnectionUpdateDataSchema,
  isStdioParameters,
  parseVirtualUrl,
  buildVirtualUrl,
  type ConnectionEntity,
  type ConnectionCreateData,
  type ConnectionUpdateData,
  type ConnectionParameters,
  type HttpConnectionParameters,
  type StdioConnectionParameters,
  type OAuthConfig,
  type ToolDefinition,
  // Virtual MCP types
  VirtualMCPEntitySchema,
  VirtualMCPCreateDataSchema,
  VirtualMCPUpdateDataSchema,
  type VirtualMCPEntity,
  type VirtualMCPCreateData,
  type VirtualMCPUpdateData,
  type VirtualMCPConnection,
  // Decopilot event types
  THREAD_STATUSES,
  THREAD_DISPLAY_STATUSES,
  DECOPILOT_EVENTS,
  ALL_DECOPILOT_EVENT_TYPES,
  createDecopilotStepEvent,
  createDecopilotFinishEvent,
  createDecopilotThreadStatusEvent,
  type ThreadStatus,
  type ThreadDisplayStatus,
  type DecopilotEventType,
  type DecopilotStepEvent,
  type DecopilotFinishEvent,
  type DecopilotThreadStatusEvent,
  type DecopilotSSEEvent,
  type DecopilotEventMap,
} from "./types";

// Streamable HTTP transport
export { StreamableHTTPClientTransport } from "./lib/streamable-http-client-transport";

// Bridge transport
export {
  createBridgeTransportPair,
  BridgeClientTransport,
  BridgeServerTransport,
  type BridgeTransportPair,
} from "./lib/bridge-transport";

// Server-client bridge
export {
  createServerFromClient,
  type ServerFromClientOptions,
} from "./lib/server-client-bridge";

// Query keys
export { KEYS } from "./lib/query-keys";

// Default model selection
export {
  DEFAULT_MODEL_PREFERENCES,
  FAST_MODEL_PREFERENCES,
  selectDefaultModel,
  getFastModel,
} from "./lib/default-model";

// MCP OAuth utilities
export {
  authenticateMcp,
  handleOAuthCallback,
  isConnectionAuthenticated,
  setOAuthRedirectOrigin,
  type McpOAuthProviderOptions,
  type OAuthTokenInfo,
  type AuthenticateMcpResult,
  type McpAuthStatus,
  type OAuthWindowMode,
} from "./lib/mcp-oauth";

// Usage utilities
export {
  getCostFromUsage,
  emptyUsageStats,
  addUsage,
  calculateUsageStats,
  sanitizeProviderMetadata,
  type UsageData,
  type UsageStats,
} from "./lib/usage";

// Constants and well-known MCP definitions
export {
  // Frontend self MCP ID
  SELF_MCP_ALIAS_ID,
  // Frontend dev-assets MCP ID
  DEV_ASSETS_MCP_ALIAS_ID,
  // Org-scoped MCP ID generators
  WellKnownOrgMCPId,
  // Connection factory functions
  getWellKnownRegistryConnection,
  getWellKnownCommunityRegistryConnection,
  getWellKnownSelfConnection,
  getWellKnownDevAssetsConnection,
  getWellKnownOpenRouterConnection,
  getWellKnownMcpStudioConnection,
  // Virtual MCP factory functions
  getWellKnownDecopilotVirtualMCP,
  getWellKnownDecopilotConnection,
  // Decopilot utilities
  isDecopilot,
  getDecopilotId,
} from "./lib/constants";
