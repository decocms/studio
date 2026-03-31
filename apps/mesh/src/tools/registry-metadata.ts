/**
 * Tool Registry
 *
 * Metadata for all management tools, used for:
 * - OAuth consent UI (displaying available permissions)
 * - API documentation
 * - Tool discovery
 * - Role permission selection
 *
 * NOTE: This file is imported by frontend code. Do NOT import runtime values
 * from ./index (only type imports are safe, but they cause circular issues).
 *
 * Keep ALL_TOOL_NAMES in sync with ALL_TOOLS in index.ts manually.
 * A test can verify they match.
 */

// ============================================================================
// Types
// ============================================================================

export type ToolCategory =
  | "Organizations"
  | "Connections"
  | "Virtual MCPs"
  | "Threads"
  | "Monitoring"
  | "Users"
  | "API Keys"
  | "Event Bus"
  | "Tags"
  | "AI Providers"
  | "Automations"
  | "Registry";

/**
 * All tool names - keep in sync with ALL_TOOLS in index.ts
 */
const ALL_TOOL_NAMES = [
  // Organization tools
  "ORGANIZATION_CREATE",
  "ORGANIZATION_LIST",
  "ORGANIZATION_GET",
  "ORGANIZATION_UPDATE",
  "ORGANIZATION_DELETE",
  "ORGANIZATION_SETTINGS_GET",
  "ORGANIZATION_SETTINGS_UPDATE",
  "ORGANIZATION_MEMBER_ADD",
  "ORGANIZATION_MEMBER_REMOVE",
  "ORGANIZATION_MEMBER_LIST",
  "ORGANIZATION_MEMBER_UPDATE_ROLE",
  // Connection tools
  "COLLECTION_CONNECTIONS_CREATE",
  "COLLECTION_CONNECTIONS_LIST",
  "COLLECTION_CONNECTIONS_GET",
  "COLLECTION_CONNECTIONS_UPDATE",
  "COLLECTION_CONNECTIONS_DELETE",
  "CONNECTION_TEST",
  // Virtual MCP tools
  "COLLECTION_VIRTUAL_MCP_CREATE",
  "COLLECTION_VIRTUAL_MCP_LIST",
  "COLLECTION_VIRTUAL_MCP_GET",
  "COLLECTION_VIRTUAL_MCP_UPDATE",
  "COLLECTION_VIRTUAL_MCP_DELETE",
  // Database tools
  "DATABASES_RUN_SQL",
  // Monitoring tools
  "MONITORING_LOGS_LIST",
  "MONITORING_STATS",
  // API Key tools
  "API_KEY_CREATE",
  "API_KEY_LIST",
  "API_KEY_UPDATE",
  "API_KEY_DELETE",
  // Event Bus tools
  "EVENT_PUBLISH",
  "EVENT_SUBSCRIBE",
  "EVENT_UNSUBSCRIBE",
  "EVENT_CANCEL",
  "EVENT_ACK",
  "EVENT_SUBSCRIPTION_LIST",
  "EVENT_SYNC_SUBSCRIPTIONS",
  // User tools
  "USER_GET",
  // Thread tools
  "COLLECTION_THREADS_CREATE",
  "COLLECTION_THREADS_LIST",
  "COLLECTION_THREADS_GET",
  "COLLECTION_THREADS_UPDATE",
  "COLLECTION_THREADS_DELETE",
  "COLLECTION_THREAD_MESSAGES_LIST",
  // Tag tools
  "TAGS_LIST",
  "TAGS_CREATE",
  "TAGS_DELETE",
  "MEMBER_TAGS_GET",
  "MEMBER_TAGS_SET",
  // Automation tools
  "AUTOMATION_CREATE",
  "AUTOMATION_GET",
  "AUTOMATION_LIST",
  "AUTOMATION_UPDATE",
  "AUTOMATION_DELETE",
  "AUTOMATION_TRIGGER_ADD",
  "AUTOMATION_TRIGGER_REMOVE",
  "AUTOMATION_RUN",
  // Virtual MCP plugin config and pinned views tools
  "VIRTUAL_MCP_PLUGIN_CONFIG_GET",
  "VIRTUAL_MCP_PLUGIN_CONFIG_UPDATE",
  "VIRTUAL_MCP_PINNED_VIEWS_UPDATE",

  // Ai providers tools
  "AI_PROVIDERS_LIST",
  "AI_PROVIDERS_LIST_MODELS",
  "AI_PROVIDERS_ACTIVE",
  "AI_PROVIDER_KEY_CREATE",
  "AI_PROVIDER_KEY_LIST",
  "AI_PROVIDER_KEY_DELETE",
  "AI_PROVIDER_OAUTH_URL",
  "AI_PROVIDER_OAUTH_EXCHANGE",
  "AI_PROVIDER_TOPUP_URL",
  "AI_PROVIDER_CREDITS",
  "AI_PROVIDER_CLI_ACTIVATE",

  // Registry tools
  "COLLECTION_REGISTRY_APP_LIST",
  "COLLECTION_REGISTRY_APP_GET",
  "COLLECTION_REGISTRY_APP_VERSIONS",
  "COLLECTION_REGISTRY_APP_FILTERS",
  "REGISTRY_ITEM_LIST",
  "REGISTRY_ITEM_SEARCH",
  "REGISTRY_ITEM_GET",
  "REGISTRY_ITEM_VERSIONS",
  "REGISTRY_ITEM_CREATE",
  "REGISTRY_ITEM_BULK_CREATE",
  "REGISTRY_ITEM_UPDATE",
  "REGISTRY_ITEM_DELETE",
  "REGISTRY_ITEM_FILTERS",
  "REGISTRY_DISCOVER_TOOLS",
  "REGISTRY_AI_GENERATE",
  "REGISTRY_PUBLISH_REQUEST_LIST",
  "REGISTRY_PUBLISH_REQUEST_REVIEW",
  "REGISTRY_PUBLISH_REQUEST_COUNT",
  "REGISTRY_PUBLISH_REQUEST_DELETE",
  "REGISTRY_PUBLISH_API_KEY_GENERATE",
  "REGISTRY_PUBLISH_API_KEY_LIST",
  "REGISTRY_PUBLISH_API_KEY_REVOKE",
  "REGISTRY_MONITOR_RUN_START",
  "REGISTRY_MONITOR_RUN_LIST",
  "REGISTRY_MONITOR_RUN_GET",
  "REGISTRY_MONITOR_RUN_CANCEL",
  "REGISTRY_MONITOR_RESULT_LIST",
  "REGISTRY_MONITOR_CONNECTION_LIST",
  "REGISTRY_MONITOR_CONNECTION_SYNC",
  "REGISTRY_MONITOR_CONNECTION_UPDATE_AUTH",
  "REGISTRY_MONITOR_SCHEDULE_SET",
  "REGISTRY_MONITOR_SCHEDULE_CANCEL",
] as const;

/**
 * ToolName type derived from ALL_TOOL_NAMES
 */
export type ToolName = (typeof ALL_TOOL_NAMES)[number];

export interface ToolMetadata {
  name: ToolName;
  description: string;
  category: ToolCategory;
  dangerous?: boolean; // Requires extra confirmation
}

/**
 * Permission option for UI components
 */
export interface PermissionOption {
  value: ToolName;
  label: string;
  dangerous?: boolean;
}

/**
 * Grouped permissions by category for UI
 */
export interface PermissionGroup {
  category: ToolCategory;
  label: string;
  permissions: PermissionOption[];
}

// ============================================================================
// Tool Metadata (static - no server imports)
// ============================================================================

/**
 * All management tools with metadata
 * Defined statically to avoid importing server-side tool implementations
 */
export const MANAGEMENT_TOOLS: ToolMetadata[] = [
  // Organization tools
  {
    name: "ORGANIZATION_CREATE",
    description: "Create a new organization",
    category: "Organizations",
  },
  {
    name: "ORGANIZATION_LIST",
    description: "List organizations",
    category: "Organizations",
  },
  {
    name: "ORGANIZATION_GET",
    description: "View organization details",
    category: "Organizations",
  },
  {
    name: "ORGANIZATION_UPDATE",
    description: "Update organization",
    category: "Organizations",
  },
  {
    name: "ORGANIZATION_DELETE",
    description: "Delete organization",
    category: "Organizations",
    dangerous: true,
  },
  {
    name: "ORGANIZATION_SETTINGS_GET",
    description: "View organization settings",
    category: "Organizations",
  },
  {
    name: "ORGANIZATION_SETTINGS_UPDATE",
    description: "Update organization settings",
    category: "Organizations",
  },
  {
    name: "ORGANIZATION_MEMBER_ADD",
    description: "Add members",
    category: "Organizations",
  },
  {
    name: "ORGANIZATION_MEMBER_REMOVE",
    description: "Remove members",
    category: "Organizations",
    dangerous: true,
  },
  {
    name: "ORGANIZATION_MEMBER_LIST",
    description: "List members",
    category: "Organizations",
  },
  {
    name: "ORGANIZATION_MEMBER_UPDATE_ROLE",
    description: "Update member roles",
    category: "Organizations",
  },
  // Connection tools
  {
    name: "COLLECTION_CONNECTIONS_CREATE",
    description: "Create connections",
    category: "Connections",
  },
  {
    name: "COLLECTION_CONNECTIONS_LIST",
    description: "List connections",
    category: "Connections",
  },
  {
    name: "COLLECTION_CONNECTIONS_GET",
    description: "View connection details",
    category: "Connections",
  },
  {
    name: "COLLECTION_CONNECTIONS_UPDATE",
    description: "Update connections",
    category: "Connections",
  },
  {
    name: "COLLECTION_CONNECTIONS_DELETE",
    description: "Delete connections",
    category: "Connections",
    dangerous: true,
  },
  {
    name: "CONNECTION_TEST",
    description: "Test connections",
    category: "Connections",
  },
  {
    name: "DATABASES_RUN_SQL",
    description: "Run SQL queries",
    category: "Connections",
    dangerous: true,
  },
  // Virtual MCP tools
  {
    name: "COLLECTION_VIRTUAL_MCP_CREATE",
    description: "Create virtual MCPs",
    category: "Virtual MCPs",
  },
  {
    name: "COLLECTION_VIRTUAL_MCP_LIST",
    description: "List virtual MCPs",
    category: "Virtual MCPs",
  },
  {
    name: "COLLECTION_VIRTUAL_MCP_GET",
    description: "View virtual MCP details",
    category: "Virtual MCPs",
  },
  {
    name: "COLLECTION_VIRTUAL_MCP_UPDATE",
    description: "Update virtual MCPs",
    category: "Virtual MCPs",
  },
  {
    name: "COLLECTION_VIRTUAL_MCP_DELETE",
    description: "Delete virtual MCPs",
    category: "Virtual MCPs",
    dangerous: true,
  },
  // Monitoring tools
  {
    name: "MONITORING_LOGS_LIST",
    description: "List monitoring logs",
    category: "Monitoring",
  },
  {
    name: "MONITORING_STATS",
    description: "View monitoring statistics",
    category: "Monitoring",
  },
  {
    name: "API_KEY_CREATE",
    description: "Create API key",
    category: "API Keys",
  },
  {
    name: "API_KEY_LIST",
    description: "List API keys",
    category: "API Keys",
  },
  {
    name: "API_KEY_UPDATE",
    description: "Update API key",
    category: "API Keys",
  },
  {
    name: "API_KEY_DELETE",
    description: "Delete API key",
    category: "API Keys",
    dangerous: true,
  },
  // Event Bus tools
  {
    name: "EVENT_PUBLISH",
    description: "Publish events",
    category: "Event Bus",
  },
  {
    name: "EVENT_SUBSCRIBE",
    description: "Subscribe to events",
    category: "Event Bus",
  },
  {
    name: "EVENT_UNSUBSCRIBE",
    description: "Unsubscribe from events",
    category: "Event Bus",
  },
  {
    name: "EVENT_CANCEL",
    description: "Cancel recurring events",
    category: "Event Bus",
  },
  {
    name: "EVENT_ACK",
    description: "Acknowledge event delivery",
    category: "Event Bus",
  },
  {
    name: "EVENT_SUBSCRIPTION_LIST",
    description: "List event subscriptions",
    category: "Event Bus",
  },
  {
    name: "EVENT_SYNC_SUBSCRIPTIONS",
    description: "Sync subscriptions to desired state",
    category: "Event Bus",
  },
  // User tools
  {
    name: "USER_GET",
    description: "Get a user by id",
    category: "Users",
  },
  // Thread tools
  {
    name: "COLLECTION_THREADS_CREATE",
    description: "Create threads",
    category: "Threads",
  },
  {
    name: "COLLECTION_THREADS_LIST",
    description: "List threads",
    category: "Threads",
  },
  {
    name: "COLLECTION_THREADS_GET",
    description: "View thread details",
    category: "Threads",
  },
  {
    name: "COLLECTION_THREADS_UPDATE",
    description: "Update threads",
    category: "Threads",
  },
  {
    name: "COLLECTION_THREADS_DELETE",
    description: "Delete threads",
    category: "Threads",
    dangerous: true,
  },
  {
    name: "COLLECTION_THREAD_MESSAGES_LIST",
    description: "List thread messages",
    category: "Threads",
  },
  // Tag tools
  {
    name: "TAGS_LIST",
    description: "List organization tags",
    category: "Tags",
  },
  {
    name: "TAGS_CREATE",
    description: "Create organization tag",
    category: "Tags",
  },
  {
    name: "TAGS_DELETE",
    description: "Delete organization tag",
    category: "Tags",
    dangerous: true,
  },
  {
    name: "MEMBER_TAGS_GET",
    description: "Get member tags",
    category: "Tags",
  },
  {
    name: "MEMBER_TAGS_SET",
    description: "Set member tags",
    category: "Tags",
  },
  // Automation tools
  {
    name: "AUTOMATION_CREATE",
    description: "Create automation",
    category: "Automations",
  },
  {
    name: "AUTOMATION_GET",
    description: "View automation details",
    category: "Automations",
  },
  {
    name: "AUTOMATION_LIST",
    description: "List automations",
    category: "Automations",
  },
  {
    name: "AUTOMATION_UPDATE",
    description: "Update automation",
    category: "Automations",
  },
  {
    name: "AUTOMATION_DELETE",
    description: "Delete automation",
    category: "Automations",
    dangerous: true,
  },
  {
    name: "AUTOMATION_TRIGGER_ADD",
    description: "Add trigger to automation",
    category: "Automations",
  },
  {
    name: "AUTOMATION_TRIGGER_REMOVE",
    description: "Remove trigger from automation",
    category: "Automations",
  },
  {
    name: "AUTOMATION_RUN",
    description: "Manually trigger an automation run",
    category: "Automations",
  },
  // Virtual MCP plugin config and pinned views tools
  {
    name: "VIRTUAL_MCP_PLUGIN_CONFIG_GET",
    description: "View virtual MCP plugin configuration",
    category: "Virtual MCPs",
  },
  {
    name: "VIRTUAL_MCP_PLUGIN_CONFIG_UPDATE",
    description: "Update virtual MCP plugin configuration",
    category: "Virtual MCPs",
  },
  {
    name: "VIRTUAL_MCP_PINNED_VIEWS_UPDATE",
    description: "Update virtual MCP pinned sidebar views",
    category: "Virtual MCPs",
  },
  {
    name: "AI_PROVIDERS_LIST",
    description: "List available AI providers",
    category: "AI Providers",
  },
  {
    name: "AI_PROVIDERS_LIST_MODELS",
    description: "List AI provider models",
    category: "AI Providers",
  },
  {
    name: "AI_PROVIDERS_ACTIVE",
    description: "List active AI providers",
    category: "AI Providers",
  },
  {
    name: "AI_PROVIDER_KEY_CREATE",
    description: "Store AI provider API key",
    category: "AI Providers",
  },
  {
    name: "AI_PROVIDER_KEY_LIST",
    description: "List AI provider API keys",
    category: "AI Providers",
  },
  {
    name: "AI_PROVIDER_KEY_DELETE",
    description: "Delete AI provider API key",
    category: "AI Providers",
    dangerous: true,
  },
  {
    name: "AI_PROVIDER_OAUTH_URL",
    description: "Get OAuth URL for provider",
    category: "AI Providers",
  },
  {
    name: "AI_PROVIDER_OAUTH_EXCHANGE",
    description: "Exchange OAuth code for API key",
    category: "AI Providers",
  },
  {
    name: "AI_PROVIDER_TOPUP_URL",
    description: "Get checkout URL to top up provider credits",
    category: "AI Providers",
  },
  {
    name: "AI_PROVIDER_CREDITS",
    description: "Get current credit balance for a provider",
    category: "AI Providers",
  },
  {
    name: "AI_PROVIDER_CLI_ACTIVATE",
    description: "Activate Claude Code via local CLI",
    category: "AI Providers",
  },
  // Registry tools
  {
    name: "COLLECTION_REGISTRY_APP_LIST",
    description: "List registry apps",
    category: "Registry",
  },
  {
    name: "COLLECTION_REGISTRY_APP_GET",
    description: "Get registry app details",
    category: "Registry",
  },
  {
    name: "COLLECTION_REGISTRY_APP_VERSIONS",
    description: "List registry app versions",
    category: "Registry",
  },
  {
    name: "COLLECTION_REGISTRY_APP_FILTERS",
    description: "Get registry app filters",
    category: "Registry",
  },
  {
    name: "REGISTRY_ITEM_LIST",
    description: "List private registry items",
    category: "Registry",
  },
  {
    name: "REGISTRY_ITEM_SEARCH",
    description: "Search registry items",
    category: "Registry",
  },
  {
    name: "REGISTRY_ITEM_GET",
    description: "Get registry item details",
    category: "Registry",
  },
  {
    name: "REGISTRY_ITEM_VERSIONS",
    description: "List registry item versions",
    category: "Registry",
  },
  {
    name: "REGISTRY_ITEM_CREATE",
    description: "Create registry item",
    category: "Registry",
  },
  {
    name: "REGISTRY_ITEM_BULK_CREATE",
    description: "Bulk create registry items",
    category: "Registry",
  },
  {
    name: "REGISTRY_ITEM_UPDATE",
    description: "Update registry item",
    category: "Registry",
  },
  {
    name: "REGISTRY_ITEM_DELETE",
    description: "Delete registry item",
    category: "Registry",
    dangerous: true,
  },
  {
    name: "REGISTRY_ITEM_FILTERS",
    description: "Get registry item filters",
    category: "Registry",
  },
  {
    name: "REGISTRY_DISCOVER_TOOLS",
    description: "Discover tools from MCP server",
    category: "Registry",
  },
  {
    name: "REGISTRY_AI_GENERATE",
    description: "AI-generate registry content",
    category: "Registry",
  },
  {
    name: "REGISTRY_PUBLISH_REQUEST_LIST",
    description: "List publish requests",
    category: "Registry",
  },
  {
    name: "REGISTRY_PUBLISH_REQUEST_REVIEW",
    description: "Review publish request",
    category: "Registry",
  },
  {
    name: "REGISTRY_PUBLISH_REQUEST_COUNT",
    description: "Count pending publish requests",
    category: "Registry",
  },
  {
    name: "REGISTRY_PUBLISH_REQUEST_DELETE",
    description: "Delete publish request",
    category: "Registry",
    dangerous: true,
  },
  {
    name: "REGISTRY_PUBLISH_API_KEY_GENERATE",
    description: "Generate publish API key",
    category: "Registry",
  },
  {
    name: "REGISTRY_PUBLISH_API_KEY_LIST",
    description: "List publish API keys",
    category: "Registry",
  },
  {
    name: "REGISTRY_PUBLISH_API_KEY_REVOKE",
    description: "Revoke publish API key",
    category: "Registry",
    dangerous: true,
  },
  {
    name: "REGISTRY_MONITOR_RUN_START",
    description: "Start monitor run",
    category: "Registry",
  },
  {
    name: "REGISTRY_MONITOR_RUN_LIST",
    description: "List monitor runs",
    category: "Registry",
  },
  {
    name: "REGISTRY_MONITOR_RUN_GET",
    description: "Get monitor run details",
    category: "Registry",
  },
  {
    name: "REGISTRY_MONITOR_RUN_CANCEL",
    description: "Cancel monitor run",
    category: "Registry",
  },
  {
    name: "REGISTRY_MONITOR_RESULT_LIST",
    description: "List monitor results",
    category: "Registry",
  },
  {
    name: "REGISTRY_MONITOR_CONNECTION_LIST",
    description: "List monitor connections",
    category: "Registry",
  },
  {
    name: "REGISTRY_MONITOR_CONNECTION_SYNC",
    description: "Sync monitor connections",
    category: "Registry",
  },
  {
    name: "REGISTRY_MONITOR_CONNECTION_UPDATE_AUTH",
    description: "Update monitor connection auth",
    category: "Registry",
  },
  {
    name: "REGISTRY_MONITOR_SCHEDULE_SET",
    description: "Set monitor schedule",
    category: "Registry",
  },
  {
    name: "REGISTRY_MONITOR_SCHEDULE_CANCEL",
    description: "Cancel monitor schedule",
    category: "Registry",
  },
];

/**
 * Human-readable labels for tool names
 */
const TOOL_LABELS: Record<ToolName, string> = {
  ORGANIZATION_CREATE: "Create organization",
  ORGANIZATION_LIST: "List organizations",
  ORGANIZATION_GET: "View organization details",
  ORGANIZATION_UPDATE: "Update organization",
  ORGANIZATION_DELETE: "Delete organization",
  ORGANIZATION_SETTINGS_GET: "View organization settings",
  ORGANIZATION_SETTINGS_UPDATE: "Update organization settings",
  ORGANIZATION_MEMBER_LIST: "List members",
  ORGANIZATION_MEMBER_ADD: "Add members",
  ORGANIZATION_MEMBER_REMOVE: "Remove members",
  ORGANIZATION_MEMBER_UPDATE_ROLE: "Update member roles",
  COLLECTION_CONNECTIONS_LIST: "List connections",
  COLLECTION_CONNECTIONS_GET: "View connection details",
  COLLECTION_CONNECTIONS_CREATE: "Create connections",
  COLLECTION_CONNECTIONS_UPDATE: "Update connections",
  COLLECTION_CONNECTIONS_DELETE: "Delete connections",
  CONNECTION_TEST: "Test connections",
  DATABASES_RUN_SQL: "Run SQL queries",
  COLLECTION_VIRTUAL_MCP_CREATE: "Create virtual MCPs",
  COLLECTION_VIRTUAL_MCP_LIST: "List virtual MCPs",
  COLLECTION_VIRTUAL_MCP_GET: "View virtual MCP details",
  COLLECTION_VIRTUAL_MCP_UPDATE: "Update virtual MCPs",
  COLLECTION_VIRTUAL_MCP_DELETE: "Delete virtual MCPs",
  MONITORING_LOGS_LIST: "List monitoring logs",
  MONITORING_STATS: "View monitoring statistics",
  API_KEY_CREATE: "Create API key",
  API_KEY_LIST: "List API keys",
  API_KEY_UPDATE: "Update API key",
  API_KEY_DELETE: "Delete API key",
  EVENT_PUBLISH: "Publish events",
  EVENT_SUBSCRIBE: "Subscribe to events",
  EVENT_UNSUBSCRIBE: "Unsubscribe from events",
  EVENT_CANCEL: "Cancel recurring events",
  EVENT_ACK: "Acknowledge event delivery",
  EVENT_SUBSCRIPTION_LIST: "List event subscriptions",
  EVENT_SYNC_SUBSCRIPTIONS: "Sync subscriptions to desired state",

  USER_GET: "Get user by id",
  COLLECTION_THREADS_CREATE: "Create threads",
  COLLECTION_THREADS_LIST: "List threads",
  COLLECTION_THREADS_GET: "View thread details",
  COLLECTION_THREADS_UPDATE: "Update threads",
  COLLECTION_THREADS_DELETE: "Delete threads",
  COLLECTION_THREAD_MESSAGES_LIST: "List thread messages",
  TAGS_LIST: "List organization tags",
  TAGS_CREATE: "Create organization tag",
  TAGS_DELETE: "Delete organization tag",
  MEMBER_TAGS_GET: "Get member tags",
  MEMBER_TAGS_SET: "Set member tags",
  VIRTUAL_MCP_PLUGIN_CONFIG_GET: "View plugin config",
  VIRTUAL_MCP_PLUGIN_CONFIG_UPDATE: "Update plugin config",
  VIRTUAL_MCP_PINNED_VIEWS_UPDATE: "Update pinned views",
  AUTOMATION_CREATE: "Create automation",
  AUTOMATION_GET: "View automation details",
  AUTOMATION_LIST: "List automations",
  AUTOMATION_UPDATE: "Update automation",
  AUTOMATION_DELETE: "Delete automation",
  AUTOMATION_TRIGGER_ADD: "Add trigger",
  AUTOMATION_TRIGGER_REMOVE: "Remove trigger",
  AUTOMATION_RUN: "Run automation",

  AI_PROVIDERS_LIST: "List AI providers",
  AI_PROVIDERS_LIST_MODELS: "List AI models",
  AI_PROVIDERS_ACTIVE: "List active providers",
  AI_PROVIDER_KEY_CREATE: "Create provider key",
  AI_PROVIDER_KEY_LIST: "List provider keys",
  AI_PROVIDER_KEY_DELETE: "Delete provider key",
  AI_PROVIDER_OAUTH_URL: "Get OAuth URL",
  AI_PROVIDER_OAUTH_EXCHANGE: "Connect via OAuth",
  AI_PROVIDER_TOPUP_URL: "Get top-up checkout URL",
  AI_PROVIDER_CREDITS: "Get credit balance",
  AI_PROVIDER_CLI_ACTIVATE: "Activate Claude Code CLI",

  // Registry
  COLLECTION_REGISTRY_APP_LIST: "List registry apps",
  COLLECTION_REGISTRY_APP_GET: "Get registry app",
  COLLECTION_REGISTRY_APP_VERSIONS: "List registry app versions",
  COLLECTION_REGISTRY_APP_FILTERS: "Get registry filters",
  REGISTRY_ITEM_LIST: "List registry items",
  REGISTRY_ITEM_SEARCH: "Search registry",
  REGISTRY_ITEM_GET: "Get registry item",
  REGISTRY_ITEM_VERSIONS: "List item versions",
  REGISTRY_ITEM_CREATE: "Create registry item",
  REGISTRY_ITEM_BULK_CREATE: "Bulk create items",
  REGISTRY_ITEM_UPDATE: "Update registry item",
  REGISTRY_ITEM_DELETE: "Delete registry item",
  REGISTRY_ITEM_FILTERS: "Get item filters",
  REGISTRY_DISCOVER_TOOLS: "Discover tools",
  REGISTRY_AI_GENERATE: "AI generate content",
  REGISTRY_PUBLISH_REQUEST_LIST: "List publish requests",
  REGISTRY_PUBLISH_REQUEST_REVIEW: "Review publish request",
  REGISTRY_PUBLISH_REQUEST_COUNT: "Count publish requests",
  REGISTRY_PUBLISH_REQUEST_DELETE: "Delete publish request",
  REGISTRY_PUBLISH_API_KEY_GENERATE: "Generate API key",
  REGISTRY_PUBLISH_API_KEY_LIST: "List API keys",
  REGISTRY_PUBLISH_API_KEY_REVOKE: "Revoke API key",
  REGISTRY_MONITOR_RUN_START: "Start monitor run",
  REGISTRY_MONITOR_RUN_LIST: "List monitor runs",
  REGISTRY_MONITOR_RUN_GET: "Get monitor run",
  REGISTRY_MONITOR_RUN_CANCEL: "Cancel monitor run",
  REGISTRY_MONITOR_RESULT_LIST: "List monitor results",
  REGISTRY_MONITOR_CONNECTION_LIST: "List monitor connections",
  REGISTRY_MONITOR_CONNECTION_SYNC: "Sync monitor connections",
  REGISTRY_MONITOR_CONNECTION_UPDATE_AUTH: "Update connection auth",
  REGISTRY_MONITOR_SCHEDULE_SET: "Set monitor schedule",
  REGISTRY_MONITOR_SCHEDULE_CANCEL: "Cancel monitor schedule",
};

// ============================================================================
// Exports
// ============================================================================

/**
 * Get tools grouped by category
 */
export function getToolsByCategory() {
  const grouped: Record<string, ToolMetadata[]> = {
    Organizations: [],
    Connections: [],
    "Virtual MCPs": [],
    Threads: [],
    Monitoring: [],
    Users: [],
    "API Keys": [],
    "Event Bus": [],
    Tags: [],
    "AI Providers": [],
    Automations: [],
    Registry: [],
  };

  for (const tool of MANAGEMENT_TOOLS) {
    grouped[tool.category]?.push(tool);
  }

  return grouped;
}

/**
 * Get permission options for UI components (type-safe)
 * Returns flat array of all static permissions with labels
 */
export function getPermissionOptions(): PermissionOption[] {
  return MANAGEMENT_TOOLS.map((tool) => ({
    value: tool.name,
    label: TOOL_LABELS[tool.name],
    dangerous: tool.dangerous,
  }));
}
