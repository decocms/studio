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

  // Chat store (IndexedDB) queries
  threads: (locator: string) => ["threads", locator] as const,
  taskThreads: (locator: string) => ["task-threads", locator] as const,
  virtualMcpThreads: (locator: string, virtualMcpId: string) =>
    ["threads", locator, "virtual-mcp", virtualMcpId] as const,
  thread: (locator: string, threadId: string) =>
    ["thread", locator, threadId] as const,
  threadMessages: (locator: string, threadId: string) =>
    ["thread-messages", locator, threadId] as const,
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

  // Monitoring dashboards
  monitoringDashboards: (locator: ProjectLocator) =>
    ["monitoring", "dashboards", locator] as const,
  monitoringDashboardDetails: (locator: ProjectLocator, dashboardId: string) =>
    ["monitoring", "dashboard", locator, dashboardId] as const,
  monitoringDashboardQuery: (
    locator: ProjectLocator,
    dashboardId: string,
    startDate: string,
    endDate: string,
    propertyFilters?: string,
  ) =>
    [
      "monitoringDashboardQuery",
      locator,
      dashboardId,
      startDate,
      endDate,
      propertyFilters ?? "",
    ] as const,

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

  // Projects (scoped by organization)
  projects: (organizationId: string) => ["projects", organizationId] as const,
  project: (organizationId: string, slug: string) =>
    ["project", organizationId, slug] as const,
  projectById: (projectId: string) => ["project", "byId", projectId] as const,

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
} as const;
