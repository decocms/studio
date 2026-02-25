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
  | "Code Execution"
  | "Tags"
  | "Projects"
  | "Reports";

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
  // Virtual Tool tools
  "COLLECTION_VIRTUAL_TOOLS_CREATE",
  "COLLECTION_VIRTUAL_TOOLS_LIST",
  "COLLECTION_VIRTUAL_TOOLS_GET",
  "COLLECTION_VIRTUAL_TOOLS_UPDATE",
  "COLLECTION_VIRTUAL_TOOLS_DELETE",
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
  // Code Execution tools
  "CODE_EXECUTION_SEARCH_TOOLS",
  "CODE_EXECUTION_DESCRIBE_TOOLS",
  "CODE_EXECUTION_RUN_CODE",
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
  // Project tools
  "PROJECT_LIST",
  "PROJECT_GET",
  "PROJECT_CREATE",
  "PROJECT_UPDATE",
  "PROJECT_DELETE",
  "PROJECT_PLUGIN_CONFIG_GET",
  "PROJECT_PLUGIN_CONFIG_UPDATE",
  // Reports tools
  "REPORTS_LIST",
  "REPORTS_GET",
  "REPORTS_UPDATE_STATUS",
  "REPORTS_UPSERT",
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
  // Virtual Tool tools
  {
    name: "COLLECTION_VIRTUAL_TOOLS_CREATE",
    description: "Create virtual tools on Virtual MCPs",
    category: "Virtual Tools",
  },
  {
    name: "COLLECTION_VIRTUAL_TOOLS_LIST",
    description: "List virtual tools",
    category: "Virtual Tools",
  },
  {
    name: "COLLECTION_VIRTUAL_TOOLS_GET",
    description: "View virtual tool details",
    category: "Virtual Tools",
  },
  {
    name: "COLLECTION_VIRTUAL_TOOLS_UPDATE",
    description: "Update virtual tools",
    category: "Virtual Tools",
  },
  {
    name: "COLLECTION_VIRTUAL_TOOLS_DELETE",
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
  // Code Execution tools
  {
    name: "CODE_EXECUTION_SEARCH_TOOLS",
    description: "Search available tools by name or description",
    category: "Code Execution",
  },
  {
    name: "CODE_EXECUTION_DESCRIBE_TOOLS",
    description: "Get detailed schemas for specific tools",
    category: "Code Execution",
  },
  {
    name: "CODE_EXECUTION_RUN_CODE",
    description: "Run JavaScript code in a sandbox with tool access",
    category: "Code Execution",
    dangerous: true,
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
  // Reports tools
  {
    name: "REPORTS_LIST",
    description: "List reports with optional filters",
    category: "Reports",
  },
  {
    name: "REPORTS_GET",
    description: "Get report by ID with full content",
    category: "Reports",
  },
  {
    name: "REPORTS_UPDATE_STATUS",
    description: "Update report lifecycle status",
    category: "Reports",
  },
  {
    name: "REPORTS_UPSERT",
    description: "Create or update a report",
    category: "Reports",
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
  COLLECTION_VIRTUAL_TOOLS_CREATE: "Create virtual tools",
  COLLECTION_VIRTUAL_TOOLS_LIST: "List virtual tools",
  COLLECTION_VIRTUAL_TOOLS_GET: "View virtual tool details",
  COLLECTION_VIRTUAL_TOOLS_UPDATE: "Update virtual tools",
  COLLECTION_VIRTUAL_TOOLS_DELETE: "Delete virtual tools",
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
  CODE_EXECUTION_SEARCH_TOOLS: "Search tools",
  CODE_EXECUTION_DESCRIBE_TOOLS: "Describe tools",
  CODE_EXECUTION_RUN_CODE: "Run code",
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
  PROJECT_LIST: "List projects",
  PROJECT_GET: "View project details",
  PROJECT_CREATE: "Create project",
  PROJECT_UPDATE: "Update project",
  PROJECT_DELETE: "Delete project",
  PROJECT_PLUGIN_CONFIG_GET: "View plugin config",
  PROJECT_PLUGIN_CONFIG_UPDATE: "Update plugin config",
  REPORTS_LIST: "List reports",
  REPORTS_GET: "Get report",
  REPORTS_UPDATE_STATUS: "Update report status",
  REPORTS_UPSERT: "Create or update report",
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
    "Code Execution": [],
    Tags: [],
    Projects: [],
    Reports: [],
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
