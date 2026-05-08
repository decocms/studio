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
  | "Object Storage"
  | "Registry"
  | "GitHub"
  | "VM";

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
  "BRAND_CONTEXT_LIST",
  "BRAND_CONTEXT_GET",
  "BRAND_CONTEXT_CREATE",
  "BRAND_CONTEXT_UPDATE",
  "BRAND_CONTEXT_DELETE",
  "BRAND_CONTEXT_EXTRACT",
  "BRAND_GET",
  "BRAND_LIST",
  "ORGANIZATION_DOMAIN_GET",
  "ORGANIZATION_DOMAIN_SET",
  "ORGANIZATION_DOMAIN_UPDATE",
  "ORGANIZATION_DOMAIN_CLEAR",
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
  "MONITORING_LOG_GET",
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
  "AI_PROVIDER_KEY_UPDATE",
  "AI_PROVIDER_OAUTH_URL",
  "AI_PROVIDER_OAUTH_EXCHANGE",
  "AI_PROVIDER_PROVISION_KEY",
  "AI_PROVIDER_TOPUP_URL",
  "AI_PROVIDER_CREDITS",
  "AI_PROVIDER_CLI_ACTIVATE",

  // Object Storage tools
  "LIST_OBJECTS",
  "GET_OBJECT_METADATA",
  "GET_PRESIGNED_URL",
  "PUT_PRESIGNED_URL",
  "DELETE_OBJECT",
  "DELETE_OBJECTS",

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

  // VM tools (app-only)
  "VM_START",
  "VM_DELETE",

  // GitHub tools (app-only)
  "GITHUB_LIST_USER_ORGS",
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
    name: "BRAND_CONTEXT_LIST",
    description: "List brand contexts",
    category: "Organizations",
  },
  {
    name: "BRAND_CONTEXT_GET",
    description: "View brand context",
    category: "Organizations",
  },
  {
    name: "BRAND_CONTEXT_CREATE",
    description: "Create brand context",
    category: "Organizations",
  },
  {
    name: "BRAND_CONTEXT_UPDATE",
    description: "Update brand context",
    category: "Organizations",
  },
  {
    name: "BRAND_CONTEXT_DELETE",
    description: "Delete brand context",
    category: "Organizations",
    dangerous: true,
  },
  {
    name: "BRAND_CONTEXT_EXTRACT",
    description: "Extract brand context from website",
    category: "Organizations",
  },
  {
    name: "BRAND_GET",
    description: "Get brand (binding)",
    category: "Organizations",
  },
  {
    name: "BRAND_LIST",
    description: "List brands (binding)",
    category: "Organizations",
  },
  {
    name: "ORGANIZATION_DOMAIN_GET",
    description: "Get organization domain claim",
    category: "Organizations",
  },
  {
    name: "ORGANIZATION_DOMAIN_SET",
    description: "Set organization domain claim",
    category: "Organizations",
  },
  {
    name: "ORGANIZATION_DOMAIN_UPDATE",
    description: "Update organization domain settings",
    category: "Organizations",
  },
  {
    name: "ORGANIZATION_DOMAIN_CLEAR",
    description: "Clear organization domain claim",
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
    name: "MONITORING_LOG_GET",
    description: "View monitoring log details",
    category: "Monitoring",
  },
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
    name: "AI_PROVIDER_KEY_UPDATE",
    description: "Update AI provider API key label",
    category: "AI Providers",
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
    name: "AI_PROVIDER_PROVISION_KEY",
    description: "Auto-provision API key for a provider",
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
  // Object Storage tools
  {
    name: "LIST_OBJECTS",
    description: "List objects in storage",
    category: "Object Storage",
  },
  {
    name: "GET_OBJECT_METADATA",
    description: "Get object metadata",
    category: "Object Storage",
  },
  {
    name: "GET_PRESIGNED_URL",
    description: "Generate download URL",
    category: "Object Storage",
  },
  {
    name: "PUT_PRESIGNED_URL",
    description: "Generate upload URL",
    category: "Object Storage",
  },
  {
    name: "DELETE_OBJECT",
    description: "Delete object",
    category: "Object Storage",
    dangerous: true,
  },
  {
    name: "DELETE_OBJECTS",
    description: "Delete multiple objects",
    category: "Object Storage",
    dangerous: true,
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
  {
    name: "VM_START",
    description: "Start a Freestyle VM with dev server preview",
    category: "VM",
  },
  {
    name: "VM_DELETE",
    description: "Stop and delete a Freestyle VM",
    category: "VM",
  },
  {
    name: "GITHUB_LIST_USER_ORGS",
    description: "List GitHub user's personal account and organizations",
    category: "GitHub",
  },
];

// ============================================================================
// Permission Capabilities (high-level, user-facing permissions)
// ============================================================================

export interface PermissionCapability {
  id: string;
  label: string;
  description: string;
  section: string;
  tools: ToolName[];
  dangerous?: boolean;
}

/**
 * Capability id for tools all authenticated org members can use by default.
 * The role editor hides this capability and bakes its tools into every
 * custom role's saved permission set at submit time.
 */
const BASIC_USAGE_CAPABILITY_ID = "basic-usage";

const PERMISSION_CAPABILITIES: PermissionCapability[] = [
  // Basic usage — granted to all org members, hidden from UI
  {
    id: BASIC_USAGE_CAPABILITY_ID,
    label: "Basic Usage",
    description: "Tools all org members can access by default",
    section: "Basic Usage",
    tools: [
      // View connections
      "COLLECTION_CONNECTIONS_LIST",
      "COLLECTION_CONNECTIONS_GET",
      "CONNECTION_TEST",
      // View agents
      "COLLECTION_VIRTUAL_MCP_LIST",
      "COLLECTION_VIRTUAL_MCP_GET",
      "VIRTUAL_MCP_PLUGIN_CONFIG_GET",
      // View automations
      "AUTOMATION_GET",
      "AUTOMATION_LIST",
      // View AI providers
      "AI_PROVIDERS_LIST",
      "AI_PROVIDERS_LIST_MODELS",
      "AI_PROVIDERS_ACTIVE",
      // Object storage access
      "LIST_OBJECTS",
      "GET_OBJECT_METADATA",
      "GET_PRESIGNED_URL",
      "PUT_PRESIGNED_URL",
      // VM previews
      "VM_START",
      "VM_DELETE",
    ],
  },
  // Organization
  {
    id: "org:manage",
    label: "Manage organization",
    description:
      "Edit organization settings, brand context, and domain configuration",
    section: "Organization",
    tools: [
      "ORGANIZATION_GET",
      "ORGANIZATION_LIST",
      "ORGANIZATION_UPDATE",
      "ORGANIZATION_SETTINGS_GET",
      "ORGANIZATION_SETTINGS_UPDATE",
      "BRAND_CONTEXT_LIST",
      "BRAND_CONTEXT_GET",
      "BRAND_CONTEXT_CREATE",
      "BRAND_CONTEXT_UPDATE",
      "BRAND_CONTEXT_DELETE",
      "BRAND_CONTEXT_EXTRACT",
      "BRAND_GET",
      "BRAND_LIST",
      "ORGANIZATION_DOMAIN_GET",
      "ORGANIZATION_DOMAIN_SET",
      "ORGANIZATION_DOMAIN_UPDATE",
      "ORGANIZATION_DOMAIN_CLEAR",
    ],
  },
  {
    id: "members:manage",
    label: "Manage members",
    description: "Invite members, remove them, and change their roles",
    section: "Organization",
    tools: [
      "ORGANIZATION_MEMBER_LIST",
      "ORGANIZATION_MEMBER_ADD",
      "ORGANIZATION_MEMBER_REMOVE",
      "ORGANIZATION_MEMBER_UPDATE_ROLE",
    ],
    dangerous: true,
  },
  // Connections
  {
    id: "connections:manage",
    label: "Manage connections",
    description: "Create, update, and delete connections",
    section: "Connections & Agents",
    tools: [
      "COLLECTION_CONNECTIONS_CREATE",
      "COLLECTION_CONNECTIONS_UPDATE",
      "COLLECTION_CONNECTIONS_DELETE",
    ],
    dangerous: true,
  },
  {
    id: "agents:manage",
    label: "Manage agents",
    description: "Create, configure, and delete agents",
    section: "Connections & Agents",
    tools: [
      "COLLECTION_VIRTUAL_MCP_CREATE",
      "COLLECTION_VIRTUAL_MCP_UPDATE",
      "COLLECTION_VIRTUAL_MCP_DELETE",
      "VIRTUAL_MCP_PLUGIN_CONFIG_UPDATE",
      "VIRTUAL_MCP_PINNED_VIEWS_UPDATE",
    ],
    dangerous: true,
  },
  // Automations
  {
    id: "automations:manage",
    label: "Manage automations",
    description: "Create, update, run, and delete automations",
    section: "Automations",
    tools: [
      "AUTOMATION_CREATE",
      "AUTOMATION_UPDATE",
      "AUTOMATION_DELETE",
      "AUTOMATION_TRIGGER_ADD",
      "AUTOMATION_TRIGGER_REMOVE",
      "AUTOMATION_RUN",
    ],
    dangerous: true,
  },
  // Monitoring
  {
    id: "monitoring:view",
    label: "View monitoring",
    description: "Access logs and usage statistics",
    section: "Monitoring",
    tools: ["MONITORING_LOG_GET", "MONITORING_LOGS_LIST", "MONITORING_STATS"],
  },
  // AI Providers
  {
    id: "ai-providers:manage",
    label: "Manage AI providers",
    description: "Add or remove API keys and provision provider credentials",
    section: "AI Providers",
    tools: [
      "AI_PROVIDER_KEY_CREATE",
      "AI_PROVIDER_KEY_LIST",
      "AI_PROVIDER_KEY_DELETE",
      "AI_PROVIDER_KEY_UPDATE",
      "AI_PROVIDER_OAUTH_URL",
      "AI_PROVIDER_OAUTH_EXCHANGE",
      "AI_PROVIDER_PROVISION_KEY",
      "AI_PROVIDER_TOPUP_URL",
      "AI_PROVIDER_CREDITS",
      "AI_PROVIDER_CLI_ACTIVATE",
    ],
  },
  // Organization (tags moved here from Developer)
  {
    id: "tags:manage",
    label: "Manage tags",
    description: "Create, assign, and delete organization tags",
    section: "Organization",
    tools: [
      "TAGS_LIST",
      "TAGS_CREATE",
      "TAGS_DELETE",
      "MEMBER_TAGS_GET",
      "MEMBER_TAGS_SET",
    ],
  },
  // Store & Registry
  {
    id: "registry:manage",
    label: "Manage registry",
    description: "Browse, publish, and manage items in the registry",
    section: "Store & Registry",
    tools: [
      "COLLECTION_REGISTRY_APP_LIST",
      "COLLECTION_REGISTRY_APP_GET",
      "COLLECTION_REGISTRY_APP_VERSIONS",
      "COLLECTION_REGISTRY_APP_FILTERS",
      "REGISTRY_ITEM_LIST",
      "REGISTRY_ITEM_SEARCH",
      "REGISTRY_ITEM_GET",
      "REGISTRY_ITEM_VERSIONS",
      "REGISTRY_ITEM_FILTERS",
      "REGISTRY_DISCOVER_TOOLS",
      "REGISTRY_ITEM_CREATE",
      "REGISTRY_ITEM_BULK_CREATE",
      "REGISTRY_ITEM_UPDATE",
      "REGISTRY_ITEM_DELETE",
      "REGISTRY_AI_GENERATE",
      "REGISTRY_PUBLISH_REQUEST_LIST",
      "REGISTRY_PUBLISH_REQUEST_REVIEW",
      "REGISTRY_PUBLISH_REQUEST_COUNT",
      "REGISTRY_PUBLISH_REQUEST_DELETE",
      "REGISTRY_PUBLISH_API_KEY_GENERATE",
      "REGISTRY_PUBLISH_API_KEY_LIST",
      "REGISTRY_PUBLISH_API_KEY_REVOKE",
    ],
    dangerous: true,
  },
  {
    id: "registry:monitor",
    label: "Monitor registry health",
    description: "Run health checks on registry connections and view results",
    section: "Store & Registry",
    tools: [
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
    ],
  },
  // Developer
  {
    id: "api-keys:manage",
    label: "Manage API keys",
    description: "Create, update, and revoke API keys",
    section: "Developer",
    tools: [
      "API_KEY_CREATE",
      "API_KEY_LIST",
      "API_KEY_UPDATE",
      "API_KEY_DELETE",
    ],
  },
  {
    id: "event-bus:use",
    label: "Use event bus",
    description: "Publish events and manage subscriptions",
    section: "Developer",
    tools: [
      "EVENT_PUBLISH",
      "EVENT_SUBSCRIBE",
      "EVENT_UNSUBSCRIBE",
      "EVENT_CANCEL",
      "EVENT_ACK",
      "EVENT_SUBSCRIPTION_LIST",
      "EVENT_SYNC_SUBSCRIPTIONS",
    ],
  },
  {
    id: "storage:delete",
    label: "Delete from storage",
    description: "Permanently delete files from object storage",
    section: "Developer",
    tools: ["DELETE_OBJECT", "DELETE_OBJECTS"],
    dangerous: true,
  },
  {
    id: "connections:sql",
    label: "Run SQL queries",
    description: "Execute raw SQL against connected databases",
    section: "Developer",
    tools: ["DATABASES_RUN_SQL"],
    dangerous: true,
  },
];

/**
 * Tools every authenticated org member can use by default.
 *
 * The role editor (`org-role-detail.tsx`) bakes these into every custom
 * role's saved `permission.self` array at submit time, so AccessControl
 * sees them as a normal Better Auth permission — no runtime bypass.
 *
 * ⚠️  Adding or removing a tool from the basic-usage capability above?
 *     You MUST also write a Kysely migration that backfills the change
 *     into existing custom roles in the `organizationRole` table.
 *     See `apps/mesh/migrations/073-backfill-basic-usage-roles.ts` for
 *     the pattern. Snapshot the tools you're adding inside the migration
 *     — do not import this constant from a migration (migrations are
 *     immutable history).
 */
export const BASIC_USAGE_TOOLS: ReadonlySet<string> = new Set(
  PERMISSION_CAPABILITIES.find((c) => c.id === BASIC_USAGE_CAPABILITY_ID)
    ?.tools ?? [],
);

export function getCapabilitySections(): Array<{
  section: string;
  capabilities: PermissionCapability[];
}> {
  const map = new Map<string, PermissionCapability[]>();
  for (const cap of PERMISSION_CAPABILITIES) {
    if (cap.id === BASIC_USAGE_CAPABILITY_ID) continue;
    const arr = map.get(cap.section) ?? [];
    arr.push(cap);
    map.set(cap.section, arr);
  }
  return Array.from(map.entries()).map(([section, capabilities]) => ({
    section,
    capabilities,
  }));
}

export function isCapabilityEnabled(
  cap: PermissionCapability,
  enabledTools: string[],
  allowAll: boolean,
): boolean {
  if (allowAll) return true;
  return cap.tools.every((tool) => enabledTools.includes(tool));
}

export function toggleCapabilityInTools(
  cap: PermissionCapability,
  currentTools: string[],
  enable: boolean,
): string[] {
  if (enable) {
    const toolSet = new Set(currentTools);
    for (const tool of cap.tools) toolSet.add(tool);
    return Array.from(toolSet);
  }
  const toolSet = new Set(currentTools);
  for (const tool of cap.tools) toolSet.delete(tool);
  return Array.from(toolSet);
}

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
    "Object Storage": [],
    Registry: [],
    GitHub: [],
    VM: [],
  };

  for (const tool of MANAGEMENT_TOOLS) {
    grouped[tool.category]?.push(tool);
  }

  return grouped;
}
