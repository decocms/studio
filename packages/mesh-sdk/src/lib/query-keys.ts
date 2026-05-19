/**
 * Centralized Query Keys for React Query
 *
 * This ensures consistent cache key management across the application
 * and prevents inline array declarations that are harder to maintain.
 */

import type { ProjectLocator } from "../context";

export const KEYS = {
  // Auth-related queries
  authConfig: () => ["authConfig"] as const,

  // Chat store (IndexedDB) queries
  threads: (locator: string) => ["threads", locator] as const,
  virtualMcpThreads: (locator: string, virtualMcpId: string) =>
    ["threads", locator, "virtual-mcp", virtualMcpId] as const,
  thread: (locator: string, taskId: string) =>
    ["thread", locator, taskId] as const,
  threadMessages: (locator: string, taskId: string) =>
    ["thread-messages", locator, taskId] as const,
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

  // MCP client (scoped by orgId, connectionId, token, and meshUrl)
  mcpClient: (
    orgId: string,
    connectionId: string,
    token: string,
    meshUrl: string,
  ) => ["mcp", "client", orgId, connectionId, token, meshUrl] as const,

  // MCP client-based queries (scoped by client instance)
  // Note: client can be null/undefined for skip queries that shouldn't execute
  mcpToolsList: (client: unknown) =>
    ["mcp", "client", client, "tools"] as const,
  mcpResourcesList: (client: unknown) =>
    ["mcp", "client", client, "resources"] as const,
  mcpPromptsList: (client: unknown) =>
    ["mcp", "client", client, "prompts"] as const,
  mcpReadResource: (client: unknown, uri: string) =>
    ["mcp", "client", client, "resource", uri] as const,
  mcpGetPrompt: (client: unknown, name: string, argsKey: string) =>
    ["mcp", "client", client, "prompt", name, argsKey] as const,
  mcpToolCall: (client: unknown, toolName: string, argsKey: string) =>
    ["mcp", "client", client, "tool-call", toolName, argsKey] as const,

  organizationSettings: (organizationId: string) =>
    ["organization-settings", organizationId] as const,

  // Active organization
  activeOrganization: (org: string | undefined) =>
    ["activeOrganization", org] as const,

  // Models list (scoped by organization)
  modelsList: (orgId: string) => ["models-list", orgId] as const,

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
  // scopeKey: connectionId for connection-scoped tools, virtualMcpId for virtual-mcp-scoped, etc.
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
  githubBranches: (
    orgId: string,
    orgSlug: string,
    connectionId: string | null | undefined,
    owner: string,
    repo: string,
  ) => ["github-branches", orgId, orgSlug, connectionId, owner, repo] as const,

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

  // Virtual MCP prompts (for ice breakers in chat)
  virtualMcpPrompts: (virtualMcpId: string) =>
    ["virtual-mcp", virtualMcpId, "prompts"] as const,

  // Connection prompts (for virtual MCP settings)
  connectionPrompts: (connectionId: string) =>
    ["connection", connectionId, "prompts"] as const,

  // Connection resources (for virtual MCP settings)
  connectionResources: (connectionId: string) =>
    ["connection", connectionId, "resources"] as const,

  // User data
  user: (userId: string) => ["user", userId] as const,

  // Registry app lookup (by app ID)
  registryApp: (orgId: string, appId: string) =>
    ["registry-app", orgId, appId] as const,
} as const;
