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
  | "Virtual Tools"
  | "Threads"
  | "Monitoring"
  | "Users"
  | "API Keys"
  | "Event Bus"
  | "Tags"
  | "Projects"
  | "AI Providers"
  | "Automations";

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
  "CONNECTIONS_CREATE",
  "CONNECTIONS_LIST",
  "CONNECTIONS_GET",
  "CONNECTIONS_UPDATE",
  "CONNECTIONS_DELETE",
  "CONNECTION_TEST",
  // Virtual MCP tools
  "VIRTUAL_MCP_CREATE",
  "VIRTUAL_MCP_LIST",
  "VIRTUAL_MCP_GET",
  "VIRTUAL_MCP_UPDATE",
  "VIRTUAL_MCP_DELETE",
  // Virtual Tool tools
  "VIRTUAL_TOOLS_CREATE",
  "VIRTUAL_TOOLS_LIST",
  "VIRTUAL_TOOLS_GET",
  "VIRTUAL_TOOLS_UPDATE",
  "VIRTUAL_TOOLS_DELETE",
  // Database tools
  "DATABASES_RUN_SQL",
  // Monitoring tools
  "MONITORING_LOGS_LIST",
  "MONITORING_STATS",
  // Monitoring Dashboard tools
  "MONITORING_DASHBOARD_CREATE",
  "MONITORING_DASHBOARD_GET",
  "MONITORING_DASHBOARD_LIST",
  "MONITORING_DASHBOARD_UPDATE",
  "MONITORING_DASHBOARD_DELETE",
  "MONITORING_DASHBOARD_QUERY",
  "MONITORING_WIDGET_PREVIEW",
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
  "THREADS_CREATE",
  "THREADS_LIST",
  "THREADS_GET",
  "THREADS_UPDATE",
  "THREADS_DELETE",
  "THREAD_MESSAGES_LIST",
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
  // Project tools
  "PROJECT_LIST",
  "PROJECT_GET",
  "PROJECT_CREATE",
  "PROJECT_UPDATE",
  "PROJECT_DELETE",
  "PROJECT_PLUGIN_CONFIG_GET",
  "PROJECT_PLUGIN_CONFIG_UPDATE",
  "PROJECT_CONNECTION_LIST",
  "PROJECT_CONNECTION_ADD",
  "PROJECT_CONNECTION_REMOVE",
  "PROJECT_PINNED_VIEWS_UPDATE",

  // Ai providers tools
  "AI_PROVIDERS_LIST",
  "AI_PROVIDERS_LIST_MODELS",
  "AI_PROVIDERS_ACTIVE",
  "AI_PROVIDER_KEY_CREATE",
  "AI_PROVIDER_KEY_LIST",
  "AI_PROVIDER_KEY_DELETE",
  "AI_PROVIDER_OAUTH_URL",
  "AI_PROVIDER_OAUTH_EXCHANGE",
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
    name: "CONNECTIONS_CREATE",
    description: "Create connections",
    category: "Connections",
  },
  {
    name: "CONNECTIONS_LIST",
    description: "List connections",
    category: "Connections",
  },
  {
    name: "CONNECTIONS_GET",
    description: "View connection details",
    category: "Connections",
  },
  {
    name: "CONNECTIONS_UPDATE",
    description: "Update connections",
    category: "Connections",
  },
  {
    name: "CONNECTIONS_DELETE",
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
    name: "VIRTUAL_MCP_CREATE",
    description: "Create virtual MCPs",
    category: "Virtual MCPs",
  },
  {
    name: "VIRTUAL_MCP_LIST",
    description: "List virtual MCPs",
    category: "Virtual MCPs",
  },
  {
    name: "VIRTUAL_MCP_GET",
    description: "View virtual MCP details",
    category: "Virtual MCPs",
  },
  {
    name: "VIRTUAL_MCP_UPDATE",
    description: "Update virtual MCPs",
    category: "Virtual MCPs",
  },
  {
    name: "VIRTUAL_MCP_DELETE",
    description: "Delete virtual MCPs",
    category: "Virtual MCPs",
    dangerous: true,
  },
  // Virtual Tool tools
  {
    name: "VIRTUAL_TOOLS_CREATE",
    description: "Create virtual tools on Virtual MCPs",
    category: "Virtual Tools",
  },
  {
    name: "VIRTUAL_TOOLS_LIST",
    description: "List virtual tools",
    category: "Virtual Tools",
  },
  {
    name: "VIRTUAL_TOOLS_GET",
    description: "View virtual tool details",
    category: "Virtual Tools",
  },
  {
    name: "VIRTUAL_TOOLS_UPDATE",
    description: "Update virtual tools",
    category: "Virtual Tools",
  },
  {
    name: "VIRTUAL_TOOLS_DELETE",
    description: "Delete virtual tools",
    category: "Virtual Tools",
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
  // Monitoring Dashboard tools
  {
    name: "MONITORING_DASHBOARD_CREATE",
    description: "Create monitoring dashboards",
    category: "Monitoring",
  },
  {
    name: "MONITORING_DASHBOARD_GET",
    description: "View dashboard details",
    category: "Monitoring",
  },
  {
    name: "MONITORING_DASHBOARD_LIST",
    description: "List monitoring dashboards",
    category: "Monitoring",
  },
  {
    name: "MONITORING_DASHBOARD_UPDATE",
    description: "Update monitoring dashboards",
    category: "Monitoring",
  },
  {
    name: "MONITORING_DASHBOARD_DELETE",
    description: "Delete monitoring dashboards",
    category: "Monitoring",
    dangerous: true,
  },
  {
    name: "MONITORING_DASHBOARD_QUERY",
    description: "Query dashboard widget data",
    category: "Monitoring",
  },
  {
    name: "MONITORING_WIDGET_PREVIEW",
    description: "Preview widget aggregation",
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
    name: "THREADS_CREATE",
    description: "Create threads",
    category: "Threads",
  },
  {
    name: "THREADS_LIST",
    description: "List threads",
    category: "Threads",
  },
  {
    name: "THREADS_GET",
    description: "View thread details",
    category: "Threads",
  },
  {
    name: "THREADS_UPDATE",
    description: "Update threads",
    category: "Threads",
  },
  {
    name: "THREADS_DELETE",
    description: "Delete threads",
    category: "Threads",
    dangerous: true,
  },
  {
    name: "THREAD_MESSAGES_LIST",
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
  // Project tools
  {
    name: "PROJECT_LIST",
    description: "List projects in organization",
    category: "Projects",
  },
  {
    name: "PROJECT_GET",
    description: "View project details",
    category: "Projects",
  },
  {
    name: "PROJECT_CREATE",
    description: "Create new project",
    category: "Projects",
  },
  {
    name: "PROJECT_UPDATE",
    description: "Update project",
    category: "Projects",
  },
  {
    name: "PROJECT_DELETE",
    description: "Delete project",
    category: "Projects",
    dangerous: true,
  },
  {
    name: "PROJECT_PLUGIN_CONFIG_GET",
    description: "View project plugin configuration",
    category: "Projects",
  },
  {
    name: "PROJECT_PLUGIN_CONFIG_UPDATE",
    description: "Update project plugin configuration",
    category: "Projects",
  },
  {
    name: "PROJECT_CONNECTION_LIST",
    description: "List project connections",
    category: "Projects",
  },
  {
    name: "PROJECT_CONNECTION_ADD",
    description: "Add connection to project",
    category: "Projects",
  },
  {
    name: "PROJECT_CONNECTION_REMOVE",
    description: "Remove connection from project",
    category: "Projects",
  },
  {
    name: "PROJECT_PINNED_VIEWS_UPDATE",
    description: "Update project pinned sidebar views",
    category: "Projects",
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
  CONNECTIONS_LIST: "List connections",
  CONNECTIONS_GET: "View connection details",
  CONNECTIONS_CREATE: "Create connections",
  CONNECTIONS_UPDATE: "Update connections",
  CONNECTIONS_DELETE: "Delete connections",
  CONNECTION_TEST: "Test connections",
  DATABASES_RUN_SQL: "Run SQL queries",
  VIRTUAL_MCP_CREATE: "Create virtual MCPs",
  VIRTUAL_MCP_LIST: "List virtual MCPs",
  VIRTUAL_MCP_GET: "View virtual MCP details",
  VIRTUAL_MCP_UPDATE: "Update virtual MCPs",
  VIRTUAL_MCP_DELETE: "Delete virtual MCPs",
  VIRTUAL_TOOLS_CREATE: "Create virtual tools",
  VIRTUAL_TOOLS_LIST: "List virtual tools",
  VIRTUAL_TOOLS_GET: "View virtual tool details",
  VIRTUAL_TOOLS_UPDATE: "Update virtual tools",
  VIRTUAL_TOOLS_DELETE: "Delete virtual tools",
  MONITORING_LOGS_LIST: "List monitoring logs",
  MONITORING_STATS: "View monitoring statistics",
  MONITORING_DASHBOARD_CREATE: "Create monitoring dashboards",
  MONITORING_DASHBOARD_GET: "View dashboard details",
  MONITORING_DASHBOARD_LIST: "List monitoring dashboards",
  MONITORING_DASHBOARD_UPDATE: "Update monitoring dashboards",
  MONITORING_DASHBOARD_DELETE: "Delete monitoring dashboards",
  MONITORING_DASHBOARD_QUERY: "Query dashboard widget data",
  MONITORING_WIDGET_PREVIEW: "Preview widget aggregation",
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
  THREADS_CREATE: "Create threads",
  THREADS_LIST: "List threads",
  THREADS_GET: "View thread details",
  THREADS_UPDATE: "Update threads",
  THREADS_DELETE: "Delete threads",
  THREAD_MESSAGES_LIST: "List thread messages",
  TAGS_LIST: "List organization tags",
  TAGS_CREATE: "Create organization tag",
  TAGS_DELETE: "Delete organization tag",
  MEMBER_TAGS_GET: "Get member tags",
  MEMBER_TAGS_SET: "Set member tags",
  PROJECT_LIST: "List projects",
  PROJECT_GET: "View project details",
  PROJECT_CREATE: "Create project",
  PROJECT_UPDATE: "Update project",
  PROJECT_DELETE: "Delete project",
  PROJECT_PLUGIN_CONFIG_GET: "View plugin config",
  PROJECT_PLUGIN_CONFIG_UPDATE: "Update plugin config",
  PROJECT_CONNECTION_LIST: "List project connections",
  PROJECT_CONNECTION_ADD: "Add project connection",
  PROJECT_CONNECTION_REMOVE: "Remove project connection",
  PROJECT_PINNED_VIEWS_UPDATE: "Update pinned views",
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
    "Virtual Tools": [],
    Threads: [],
    Monitoring: [],
    Users: [],
    "API Keys": [],
    "Event Bus": [],
    Tags: [],
    Projects: [],
    "AI Providers": [],
    Automations: [],
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
