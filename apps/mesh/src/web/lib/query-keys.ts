/**
 * Centralized Query Keys for React Query
 *
 * This ensures consistent cache key management across the application
 * and prevents inline array declarations that are harder to maintain.
 */

import { ProjectLocator } from "@decocms/mesh-sdk";

export const KEYS = {
  // Public config (no auth required)
  publicConfig: () => ["publicConfig"] as const,

  // Auth-related queries
  authConfig: () => ["authConfig"] as const,
  session: () => ["session"] as const,

  // Task queries (ownerFilter + userId scope the cache entry)
  // userId is included when ownerFilter is "me" to prevent cross-user cache pollution
  tasks: (
    locator: string,
    ownerFilter?: "me" | "everyone",
    userId?: string | null,
    virtualMcpId?: string,
  ): unknown[] => {
    const key: unknown[] = ["tasks", locator];
    if (ownerFilter !== undefined) key.push(ownerFilter);
    if (ownerFilter === "me") key.push(userId ?? null);
    if (virtualMcpId) key.push(virtualMcpId);
    return key;
  },
  messages: (locator: string) => ["messages", locator] as const,

  // Organizations list
  organizations: () => ["organizations"] as const,

  // Organization members (scoped by org)
  members: (locator: ProjectLocator) => [locator, "members"] as const,

  // Organization invitations (scoped by org)
  invitations: (locator: ProjectLocator) => [locator, "invitations"] as const,

  // Organization roles (scoped by org)
  organizationRoles: (locator: ProjectLocator) =>
    [locator, "organization-roles"] as const,

  // Connections (scoped by project)
  connections: (locator: ProjectLocator) => [locator, "connections"] as const,
  connectionsByBinding: (locator: ProjectLocator, binding: string) =>
    [locator, "connections", `binding:${binding}`] as const,
  connection: (locator: ProjectLocator, id: string) =>
    [locator, "connection", id] as const,

  connectionActivity: (
    connectionId: string,
    timeframe: string,
    orgId: string,
  ) => ["monitoring", "activity", connectionId, timeframe, orgId] as const,

  isMCPAuthenticated: (url: string, token: string | null) =>
    ["is-mcp-authenticated", url, token] as const,

  // MCP tools (scoped by URL and optional token)
  mcpTools: (url: string, token?: string | null) =>
    ["mcp", "tools", url, token] as const,

  organizationSettings: (organizationId: string) =>
    ["organization-settings", organizationId] as const,

  // Active organization
  activeOrganization: (org: string | undefined) =>
    ["activeOrganization", org] as const,

  // Models list (scoped by organization)
  modelsList: (orgId: string) => ["models-list", orgId] as const,

  // Allowed models for current user (scoped by organization)
  allowedModels: (locator: ProjectLocator) =>
    [locator, "allowed-models"] as const,

  // Collections (scoped by connection)
  connectionCollections: (connectionId: string) =>
    [connectionId, "collections", "discovery"] as const,

  // Tool call results (generic caching for MCP tool calls)
  // scope is required - scopes the cache (connectionId for connection-scoped, locator for org/project-scoped)
  toolCall: (scope: string, toolName: string, paramsKey: string) =>
    ["tool-call", scope, toolName, paramsKey] as const,

  // Collection items (scoped by connection and collection name)
  collectionItems: (connectionId: string, collectionName: string) =>
    ["collection", connectionId, collectionName] as const,

  // Collection CRUD queries (scoped by orgId, scopeKey, client, and collection name)
  // orgId: organization ID
  // scopeKey: connectionId for connection-scoped tools, virtualMcpId/gatewayId for scoped tools, etc.
  // client: MCP client instance for cache isolation
  // Base prefix for invalidating all collection variants
  collection: (orgId: string, scopeKey: string, collectionName: string) =>
    [orgId, scopeKey, "collection", collectionName] as const,
  // Item query
  collectionItem: (
    client: unknown,
    orgId: string,
    scopeKey: string,
    collectionName: string,
    itemId: string,
  ) => [client, orgId, scopeKey, "collection", collectionName, itemId] as const,
  // List query
  collectionList: (
    client: unknown,
    orgId: string,
    scopeKey: string,
    collectionName: string,
    paramsKey: string,
  ) =>
    [
      client,
      orgId,
      scopeKey,
      "collection",
      collectionName,
      "list",
      paramsKey,
    ] as const,
  // Infinite list query
  collectionListInfinite: (
    client: unknown,
    orgId: string,
    scopeKey: string,
    collectionName: string,
    paramsKey: string,
  ) =>
    [
      client,
      orgId,
      scopeKey,
      "collection",
      collectionName,
      "list-infinite",
      paramsKey,
    ] as const,

  // GitHub README (scoped by owner and repo)
  githubReadme: (
    owner: string | null | undefined,
    repo: string | null | undefined,
  ) => ["github-readme", owner, repo] as const,

  // Monitoring queries
  monitoringStats: () => ["monitoring", "stats"] as const,
  monitoringLogs: (filters: {
    connectionId?: string;
    toolName?: string;
    isError?: boolean;
    limit?: number;
    offset?: number;
  }) => ["monitoring", "logs", filters] as const,
  monitoringLogsInfinite: (locator: string, paramsKey: string) =>
    ["monitoring", "logs-infinite", locator, paramsKey] as const,
  monitoringLogDetail: (logId: string) =>
    ["monitoring", "log-detail", logId] as const,

  // Thread queries (scoped by locator)
  threadsInfinite: (locator: string, paramsKey: string) =>
    ["threads", "list-infinite", locator, paramsKey] as const,
  threadMessages: (locator: string, threadId: string) =>
    ["threads", "messages", locator, threadId] as const,
  threadModelLogs: (locator: string, dateKey: string) =>
    ["threads", "model-logs", locator, dateKey] as const,

  // Virtual MCP tools (for tool definition lookup in chat)
  // null virtualMcpId means default virtual MCP
  virtualMcpTools: (virtualMcpId: string | null, orgId: string) =>
    ["virtual-mcp", orgId, virtualMcpId ?? "default", "tools"] as const,

  // Virtual MCP prompts (for ice breakers in chat)
  // null virtualMcpId means default virtual MCP
  virtualMcpPrompts: (virtualMcpId: string | null, orgId: string) =>
    ["virtual-mcp", orgId, virtualMcpId ?? "default", "prompts"] as const,

  // Virtual MCP resources (for resource mentions in chat)
  // null virtualMcpId means default virtual MCP
  virtualMcpResources: (virtualMcpId: string | null, orgId: string) =>
    ["virtual-mcp", orgId, virtualMcpId ?? "default", "resources"] as const,

  // Suggestion menu items (for filtering prompts/resources in chat input)
  // Note: The hook appends `show` and `query` to this base key
  suggestionItems: (
    baseKey: readonly unknown[],
    isOpen: boolean,
    query: string,
  ) => [...baseKey, isOpen, query] as const,

  // Connection prompts (for Virtual MCP settings)
  connectionPrompts: (connectionId: string) =>
    ["connection", connectionId, "prompts"] as const,

  // Connection resources (for Virtual MCP settings)
  connectionResources: (connectionId: string) =>
    ["connection", connectionId, "resources"] as const,

  // User data
  user: (userId: string) => ["user", userId] as const,

  // Store README fetched from external URL
  storeReadmeUrl: (readmeUrl: string | null | undefined) =>
    ["store-readme-url", readmeUrl] as const,

  // Remote MCP tools (for store server detail page)
  remoteMcpTools: (remoteUrl: string | null) =>
    ["remote-mcp-tools", remoteUrl] as const,

  // Tags (scoped by locator)
  tags: (locator: string) => [locator, "tags"] as const,
  memberTags: (locator: string, memberId: string) =>
    [locator, "member-tags", memberId] as const,

  // Automations (scoped by organization, optionally by project)
  automationsAll: (organizationId: string) =>
    ["automations", organizationId] as const,
  automations: (organizationId: string, virtualMcpId?: string | null) =>
    ["automations", organizationId, virtualMcpId ?? null] as const,
  automation: (organizationId: string, id: string) =>
    ["automation", organizationId, id] as const,
  automationRuns: (
    organizationId: string,
    automationId: string,
    triggerIds?: string[],
  ) =>
    [
      "automation-runs",
      organizationId,
      automationId,
      ...[...(triggerIds ?? [])].sort(),
    ] as const,

  // Projects (scoped by organization)
  projects: (organizationId: string) => ["projects", organizationId] as const,
  project: (organizationId: string, slug: string) =>
    ["project", organizationId, slug] as const,
  // Virtual MCP entity (scoped by org + id)
  virtualMcp: (orgId: string, virtualMcpId: string) =>
    ["virtual-mcp", orgId, virtualMcpId] as const,

  // Project plugin configs
  projectPluginConfigs: (projectId: string) =>
    ["project-plugin-configs", projectId] as const,
  projectPluginConfig: (projectId: string, pluginId: string) =>
    ["project-plugin-config", projectId, pluginId] as const,

  // Project connections (dependencies)
  projectConnections: (projectId: string) =>
    ["project-connections", projectId] as const,

  // Project connection details (with tools, for sidebar)
  projectConnectionDetails: (projectId: string, connectionIds: string[]) =>
    ["project-connections", projectId, "details", connectionIds] as const,

  // AI providers (static registry — staleTime: Infinity recommended)
  aiProviders: (orgId: string) => ["ai-providers", orgId] as const,

  // AI provider models (scoped by keyId)
  aiProviderModels: (orgId: string, keyId: string) =>
    ["ai-provider-models", orgId, keyId] as const,

  // AI provider stored keys (scoped by org)
  aiProviderKeys: (orgId: string) => ["ai-provider-keys", orgId] as const,

  // AI provider credits balance (scoped by org + keyId)
  aiProviderCredits: (orgId: string, keyId: string) =>
    ["ai-provider-credits", orgId, keyId] as const,

  // Organization SSO
  orgSsoConfig: (organizationId: string) =>
    ["org-sso-config", organizationId] as const,
  orgSsoStatus: (organizationId: string) =>
    ["org-sso-status", organizationId] as const,

  // Registry config (scoped by organization)
  registryConfig: (organizationId: string) =>
    ["registry-config", organizationId] as const,

  // Store discovery (per-registry infinite query)
  storeDiscovery: (orgId: string, registryId: string) =>
    ["store-discovery", orgId, registryId] as const,

  // Prompt → connection map (scoped by org + connections)
  promptConnectionMap: (orgId: string, connectionIds: string[]) =>
    ["prompt-connection-map", orgId, ...connectionIds] as const,

  // Deco profile (scoped by user email)
  decoProfile: (email: string | undefined) => ["deco-profile", email] as const,

  // Deco sites (scoped by user email)
  decoSites: (email: string | undefined) => ["deco-sites", email] as const,
} as const;
