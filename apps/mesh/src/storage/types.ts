/**
 * Database Types for MCP Mesh
 *
 * These TypeScript interfaces define the database schema using Kysely's type-only approach.
 * The dialect (PGlite or PostgreSQL) is determined at runtime from DATABASE_URL.
 *
 * Key Principles:
 * - Database = Organization boundary (all users are org members)
 * - Organizations managed by Better Auth organization plugin
 * - Connections are organization-scoped
 * - Access control via Better Auth permissions and organization roles
 */

import type { ColumnType } from "kysely";
import type { OAuthConfig, ToolDefinition } from "../tools/connection/schema";
import type { ChatMessage } from "../api/routes/decopilot/types";
import { ThreadStatus } from "@decocms/mesh-sdk";

// ============================================================================
// Type Utilities
// ============================================================================

/**
 * Helper for JSON columns that store arrays
 * Kysely maps JSON to string in database, but T[] in TypeScript
 */
export type JsonArray<T> = ColumnType<T[], string, string>;

/**
 * Helper for JSON columns that store objects
 * Kysely maps JSON to string in database, but T in TypeScript
 */
export type JsonObject<T> = ColumnType<T, string, string>;

// ============================================================================
// Permission Type (Better Auth format)
// ============================================================================

/**
 * Permission format used by Better Auth
 * Format: { [resource]: [actions...] }
 *
 * Examples:
 * - Organization-level: { "self": ["PROJECT_CREATE", "PROJECT_LIST"] }
 * - Connection-specific: { "conn_<UUID>": ["SEND_MESSAGE", "LIST_THREADS"] }
 */
export type Permission = Record<string, string[]>;

// ============================================================================
// Core Entity Interfaces
// ============================================================================

// ============================================================================
// Database Table Definitions (for Kysely schema)
// ============================================================================

/**
 * User table definition - System users
 * Managed by Better Auth, but defined here for reference
 */
export interface UserTable {
  id: string;
  email: string;
  name: string;
  role: string; // System role: 'admin' | 'user'
  createdAt: ColumnType<Date, Date | string, never>;
  updatedAt: ColumnType<Date, Date | string, Date | string>;
}

/**
 * Better Auth core user table definition (singular: "user")
 * Includes avatar image and other auth-related fields.
 */
export interface BetterAuthUserTable {
  id: string;
  email: string;
  emailVerified: number;
  name: string;
  image: string | null;
  role: string | null;
  banned: number | null;
  banReason: string | null;
  banExpires: string | null;
  createdAt: ColumnType<Date, string, string>;
  updatedAt: ColumnType<Date, string, string>;
}
// ============================================================================
// Runtime Entity Types (for application code)
// ============================================================================

/**
 * User entity - Runtime representation
 */
export interface User {
  id: string;
  email: string;
  name: string;
  role: string;
  createdAt: Date | string;
  updatedAt: Date | string;
}

/**
 * User entity with image - Extended representation including Better Auth avatar
 */
export interface UserWithImage extends User {
  image?: string;
}

/**
 * Organization entity - Runtime representation (from Better Auth)
 * Better Auth organization plugin provides this data
 */
export interface Organization {
  id: string;
  slug: string;
  name: string;
  logo: string | null;
  metadata: Record<string, unknown> | null;
  createdAt: Date | string;
}

export interface SidebarItem {
  title: string;
  url: string;
  icon: string;
}

export interface OrganizationSettingsTable {
  organizationId: string;
  sidebar_items: JsonArray<SidebarItem[]> | null;
  enabled_plugins: JsonArray<string[]> | null;
  createdAt: ColumnType<Date, Date | string, never>;
  updatedAt: ColumnType<Date, Date | string, Date | string>;
}

export interface OrganizationSettings {
  organizationId: string;
  sidebar_items: SidebarItem[] | null;
  enabled_plugins: string[] | null;
  createdAt: Date | string;
  updatedAt: Date | string;
}

/**
 * MCP Connection table definition
 * Uses snake_case column names to align with ConnectionEntitySchema
 */
export interface MCPConnectionTable {
  id: string;
  organization_id: string; // All connections are organization-scoped
  created_by: string; // User who created this connection
  updated_by: string | null; // User who last updated this connection
  title: string;
  description: string | null;
  icon: string | null;
  app_name: string | null;
  app_id: string | null;

  // Connection details
  connection_type: "HTTP" | "SSE" | "Websocket" | "STDIO" | "VIRTUAL";
  connection_url: string | null; // Null for STDIO, virtual://$id for VIRTUAL
  connection_token: string | null; // Encrypted
  connection_headers: string | null; // JSON - encrypted envVars for STDIO

  // OAuth config for downstream MCP (if MCP supports OAuth)
  oauth_config: JsonObject<OAuthConfig> | null;

  // Configuration state (for MESH_CONFIGURATION feature)
  configuration_state: string | null; // Encrypted JSON state
  configuration_scopes: JsonArray<string[]> | null; // Array of scope strings

  // Metadata and discovery
  metadata: JsonObject<Record<string, unknown>> | null;
  tools: JsonArray<ToolDefinition[]> | null; // Discovered tools from MCP
  bindings: JsonArray<string[]> | null; // Detected bindings (CHAT, EMAIL, etc.)

  status: "active" | "inactive" | "error";
  created_at: ColumnType<Date, Date | string, never>;
  updated_at: ColumnType<Date, Date | string, Date | string>;
}

// MCPConnection runtime type is now ConnectionEntity from "../tools/connection/schema"
// OAuthConfig and ToolDefinition are also exported from schema.ts

/**
 * API Key table definition
 */
export interface ApiKeyTable {
  id: string;
  userId: string; // Owner of this API key
  name: string;
  hashedKey: string; // Hashed API key (Better Auth handles this)
  permissions: JsonObject<Permission>; // { [resource]: [actions...] }
  expiresAt: ColumnType<Date, Date | string, never> | null;
  remaining: number | null; // Request quota
  metadata: JsonObject<Record<string, unknown>> | null;
  createdAt: ColumnType<Date, Date | string, never>;
  updatedAt: ColumnType<Date, Date | string, Date | string>;
}

/**
 * API Key entity - Runtime representation
 */
export interface ApiKey {
  id: string;
  userId: string;
  name: string;
  hashedKey: string;
  permissions: Permission;
  expiresAt: Date | string | null;
  remaining: number | null;
  metadata: Record<string, unknown> | null;
  createdAt: Date | string;
  updatedAt: Date | string;
}

export interface AIProviderKeyTable {
  id: string;
  organization_id: string;
  provider_id: string; // ProviderId — enforced at app level, not DB level
  label: string;
  encrypted_api_key: string;
  created_by: string;
  created_at: ColumnType<Date, Date | string, never>;
}

/**
 * Short-lived PKCE state table — stores codeVerifier server-side during OAuth flow.
 * Records expire after 10 minutes and are deleted on consumption (single-use).
 */
export interface OAuthPkceStateTable {
  id: string; // state token (UUID), returned as stateToken to client
  organization_id: string; // scoped to the org that initiated the flow
  user_id: string; // scoped to the user that initiated the flow
  code_verifier: string; // PKCE verifier — never leaves the server
  expires_at: ColumnType<Date, Date | string, never>;
  created_at: ColumnType<Date, Date | string, never>;
}

/**
// ============================================================================
// OAuth Table Definitions (for MCP OAuth server)
// ============================================================================

/**
 * OAuth Client table definition (RFC 7591 - Dynamic Client Registration)
 */
export interface OAuthClientTable {
  id: string;
  clientId: string; // Unique
  clientSecret: string | null; // Hashed, null for public clients
  clientName: string;
  redirectUris: JsonArray<string[]>; // JSON array
  grantTypes: JsonArray<string[]>; // JSON array
  scope: string | null;
  clientUri: string | null;
  logoUri: string | null;
  createdAt: ColumnType<Date, Date | string, never>;
}

/**
 * OAuth Authorization Code table definition (PKCE support)
 */
export interface OAuthAuthorizationCodeTable {
  code: string; // Primary key
  clientId: string; // Foreign key
  userId: string;
  redirectUri: string;
  scope: string | null;
  codeChallenge: string | null; // PKCE
  codeChallengeMethod: string | null; // 'S256'
  expiresAt: ColumnType<Date, Date | string, never>;
  createdAt: ColumnType<Date, Date | string, never>;
}

/**
 * OAuth Refresh Token table definition
 */
export interface OAuthRefreshTokenTable {
  token: string; // Primary key
  clientId: string; // Foreign key
  userId: string;
  scope: string | null;
  expiresAt: ColumnType<Date, Date | string, never> | null;
  createdAt: ColumnType<Date, Date | string, never>;
}

/**
 * Downstream Token table definition - Cache tokens from downstream MCPs
 */
export interface DownstreamTokenTable {
  id: string; // Primary key
  connectionId: string; // Foreign key (unique - one token per connection)
  accessToken: string; // Encrypted
  refreshToken: string | null; // Encrypted
  scope: string | null;
  expiresAt: ColumnType<Date, Date | string, Date | string | null> | null;
  createdAt: ColumnType<Date, Date | string, never>;
  updatedAt: ColumnType<Date, Date | string, Date | string>;
  // Dynamic Client Registration info (for token refresh)
  clientId: string | null;
  clientSecret: string | null; // Encrypted
  tokenEndpoint: string | null;
}

// ============================================================================
// OAuth Runtime Entity Types
// ============================================================================

/**
 * OAuth Client entity - Runtime representation
 */
export interface OAuthClient {
  id: string;
  clientId: string;
  clientSecret: string | null;
  clientName: string;
  redirectUris: string[];
  grantTypes: string[];
  scope: string | null;
  clientUri: string | null;
  logoUri: string | null;
  createdAt: Date | string;
}

/**
 * OAuth Authorization Code entity - Runtime representation
 */
export interface OAuthAuthorizationCode {
  code: string;
  clientId: string;
  userId: string;
  redirectUri: string;
  scope: string | null;
  codeChallenge: string | null;
  codeChallengeMethod: string | null;
  expiresAt: Date | string;
  createdAt: Date | string;
}

/**
 * OAuth Refresh Token entity - Runtime representation
 */
export interface OAuthRefreshToken {
  token: string;
  clientId: string;
  userId: string;
  scope: string | null;
  expiresAt: Date | string | null;
  createdAt: Date | string;
}

/**
 * Downstream Token entity - Runtime representation
 */
export interface DownstreamToken {
  id: string;
  connectionId: string;
  accessToken: string;
  refreshToken: string | null;
  scope: string | null;
  expiresAt: Date | string | null;
  createdAt: Date | string;
  updatedAt: Date | string;
  // Dynamic Client Registration info (for token refresh)
  clientId: string | null;
  clientSecret: string | null;
  tokenEndpoint: string | null;
}

// ============================================================================
// Database Schema
// ============================================================================

// ============================================================================
// Better Auth Organization Tables (managed by Better Auth plugin)
// ============================================================================

/**
 * Better Auth organization table
 */
export interface BetterAuthOrganizationTable {
  id: string;
  name: string;
  slug: string;
  logo: string | null;
  metadata: string | null;
  createdAt: ColumnType<Date, string, string>;
}

/**
 * Better Auth member table (organization membership)
 */
export interface BetterAuthMemberTable {
  id: string;
  organizationId: string;
  userId: string;
  role: string;
  createdAt: ColumnType<Date, string, string>;
}

/**
 * Better Auth organization role table (custom roles)
 */
export interface BetterAuthOrganizationRoleTable {
  id: string;
  organizationId: string;
  role: string;
  permission: string; // JSON string
  createdAt: ColumnType<Date, string, string>;
}

/**
 * Monitoring Log runtime type
 */
export interface MonitoringLog {
  id?: string;
  organizationId: string;
  connectionId: string;
  connectionTitle: string;
  toolName: string;
  input: Record<string, unknown>;
  output: Record<string, unknown>;
  isError: boolean;
  errorMessage?: string | null;
  durationMs: number;
  timestamp: Date | string;
  userId: string | null;
  requestId: string;
  userAgent?: string | null; // x-mesh-client header
  virtualMcpId?: string | null; // Virtual MCP (Agent) ID if routed through an agent
  properties?: Record<string, string> | null; // Custom key-value metadata
}

// ============================================================================
// Monitoring Dashboard Table Definitions
// ============================================================================

/**
 * Table columns that can be used for groupBy in aggregations
 */
export type GroupByColumn =
  | "connection_id"
  | "connection_title"
  | "user_id"
  | "tool_name"
  | "virtual_mcp_id";

/**
 * Aggregation function types for dashboard widgets
 */
export type AggregationFunction =
  | "sum"
  | "avg"
  | "min"
  | "max"
  | "count"
  | "count_all"
  | "last";

/**
 * Widget display types
 */
export type WidgetType = "metric" | "timeseries" | "table";

/**
 * Dashboard widget definition
 * Defines how to extract and aggregate data from monitoring logs
 */
export interface DashboardWidget {
  id: string;
  name: string;
  type: WidgetType;

  // What to extract (JSONPath syntax)
  source: {
    path: string; // e.g., "$.usage.total_tokens"
    from: "input" | "output";
  };

  // Aggregation configuration
  aggregation: {
    fn: AggregationFunction;
    groupBy?: string; // Optional JSONPath for grouping
    groupByColumn?: GroupByColumn; // Optional table column for grouping (takes priority)
    interval?: string; // For timeseries: "1h", "1d"
  };

  // Widget-specific filter overrides
  filter?: {
    connectionIds?: string[];
    toolNames?: string[];
  };
}

/**
 * Dashboard-level filters applied to all widgets
 */
export interface DashboardFilters {
  connectionIds?: string[];
  virtualMcpIds?: string[];
  toolNames?: string[];
  propertyFilters?: Record<string, string>;
}

/**
 * Monitoring Dashboard table definition
 * Stores custom dashboards with JSONPath-based widgets
 */
export interface MonitoringDashboardTable {
  id: string;
  organization_id: string;
  name: string;
  description: string | null;
  filters: JsonObject<DashboardFilters> | null; // JSON
  widgets: JsonArray<DashboardWidget>; // JSON array
  created_by: string;
  created_at: ColumnType<Date, Date | string, never>;
  updated_at: ColumnType<Date, Date | string, Date | string>;
}

/**
 * Monitoring Dashboard runtime type
 */
export interface MonitoringDashboard {
  id: string;
  organizationId: string;
  name: string;
  description: string | null;
  filters: DashboardFilters | null;
  widgets: DashboardWidget[];
  createdBy: string;
  createdAt: Date | string;
  updatedAt: Date | string;
}

// ============================================================================
// Event Bus Table Definitions
// ============================================================================

/**
 * Event status for delivery tracking
 * - pending: Not yet processed
 * - processing: Claimed by a worker, delivery in progress
 * - delivered: Successfully delivered
 * - failed: Max retries reached, delivery failed
 */
export type EventStatus = "pending" | "processing" | "delivered" | "failed";

/**
 * Event table definition - Stores CloudEvents
 * Follows CloudEvents v1.0 specification
 */
export interface EventTable {
  id: string; // UUID
  organization_id: string;
  // CloudEvent required attributes
  type: string; // Event type (e.g., "order.created")
  source: string; // Connection ID of publisher
  specversion: string; // Always "1.0"
  // CloudEvent optional attributes
  subject: string | null; // Resource identifier
  time: string; // ISO 8601 timestamp
  datacontenttype: string; // Content type (default: "application/json")
  dataschema: string | null; // Schema URI
  data: JsonObject<unknown> | null; // JSON payload
  // Recurring event support
  cron: string | null; // Cron expression for recurring delivery
  // Delivery tracking
  status: EventStatus;
  attempts: number;
  last_error: string | null;
  next_retry_at: string | null; // ISO 8601 timestamp for retry
  // Audit fields
  created_at: ColumnType<Date, Date | string, never>;
  updated_at: ColumnType<Date, Date | string, Date | string>;
}

/**
 * Event entity - Runtime representation
 */
export interface Event {
  id: string;
  organizationId: string;
  type: string;
  source: string;
  specversion: string;
  subject: string | null;
  time: string;
  datacontenttype: string;
  dataschema: string | null;
  data: unknown | null;
  cron: string | null;
  status: EventStatus;
  attempts: number;
  lastError: string | null;
  nextRetryAt: string | null;
  createdAt: Date | string;
  updatedAt: Date | string;
}

/**
 * Event subscription table definition
 * Links subscriber connections to event type patterns
 */
export interface EventSubscriptionTable {
  id: string; // UUID
  organization_id: string;
  connection_id: string; // Subscriber connection (who receives events)
  publisher: string | null; // Filter by publisher connection (null = wildcard)
  event_type: string; // Event type pattern to match
  filter: string | null; // Optional JSONPath filter on event data
  enabled: number; // Integer column (0/1);
  created_at: ColumnType<Date, Date | string, never>;
  updated_at: ColumnType<Date, Date | string, Date | string>;
}

/**
 * Event subscription entity - Runtime representation
 */
export interface EventSubscription {
  id: string;
  organizationId: string;
  connectionId: string;
  publisher: string | null;
  eventType: string;
  filter: string | null;
  enabled: boolean;
  createdAt: Date | string;
  updatedAt: Date | string;
}

/**
 * Event delivery table definition
 * Tracks per-subscription delivery status for each event
 */
export interface EventDeliveryTable {
  id: string; // UUID
  event_id: string;
  subscription_id: string;
  status: EventStatus;
  attempts: number;
  last_error: string | null;
  delivered_at: string | null; // ISO 8601 timestamp
  next_retry_at: string | null; // ISO 8601 timestamp for next retry
  created_at: ColumnType<Date, Date | string, never>;
}

/**
 * Event delivery entity - Runtime representation
 */
export interface EventDelivery {
  id: string;
  eventId: string;
  subscriptionId: string;
  status: EventStatus;
  attempts: number;
  lastError: string | null;
  deliveredAt: string | null;
  nextRetryAt: string | null;
  createdAt: Date | string;
}

// ============================================================================
// Virtual MCP Table Definitions
// ============================================================================

/**
 * Tool selection mode for virtual MCPs
 * - "inclusion": Include selected tools/connections (default behavior)
 * - "exclusion": Exclude selected tools/connections (inverse filter)
 */
export type ToolSelectionMode = "inclusion" | "exclusion";

/**
 * Dependency mode for connection aggregations
 * - 'direct': User explicitly added this connection to the Virtual MCP (tools exposed)
 * - 'indirect': Connection is referenced by virtual tool code (FK only, tools hidden)
 */
export type DependencyMode = "direct" | "indirect";

/**
 * Connection aggregation table definition
 * Many-to-many relationship linking VIRTUAL connections (agents) to their child connections
 * with selected tools/resources/prompts
 *
 * Note: VirtualMCPTable has been eliminated. Virtual MCPs are now stored as
 * regular connections with connection_type = 'VIRTUAL'
 */
export interface ConnectionAggregationTable {
  id: string;
  parent_connection_id: string; // The VIRTUAL connection (agent)
  child_connection_id: string; // The connection being aggregated
  selected_tools: JsonArray<string[]> | null; // null = all tools
  selected_resources: JsonArray<string[]> | null; // null = all resources, supports URI patterns with * and **
  selected_prompts: JsonArray<string[]> | null; // null = all prompts
  dependency_mode: DependencyMode; // 'direct' = tools exposed, 'indirect' = FK only
  created_at: ColumnType<Date, Date | string, never>;
}

/**
 * Thread table definition
 * Threads are scopes users in organizations and store messages with Agents.
 */

/** Stored thread statuses (persisted in DB). Canonical source: @decocms/mesh-sdk */
export {
  THREAD_STATUSES,
  type ThreadStatus,
} from "@decocms/mesh-sdk";

export interface ThreadTable {
  id: string;
  organization_id: string;
  title: string;
  description: string | null;
  hidden: boolean | null;
  status: ThreadStatus;
  created_at: ColumnType<Date, Date | string, never>;
  updated_at: ColumnType<Date, Date | string, Date | string>;
  created_by: string; // User ID;
  updated_by: string | null;
}

export interface Thread {
  id: string;
  organization_id: string;
  title: string;
  description: string | null;
  created_at: string;
  updated_at: string;
  created_by: string;
  updated_by: string | null;
  hidden: boolean | null;
  status: ThreadStatus;
}

export interface ThreadMessageTable {
  id: string;
  thread_id: string;
  metadata: string | null;
  parts: JsonArray<Record<string, unknown>>;
  role: "user" | "assistant" | "system";
  created_at: ColumnType<Date, Date | string, never>;
  updated_at: ColumnType<Date, Date | string, Date | string>;
}
export interface ThreadMessage extends ChatMessage {
  thread_id: string;
  created_at: string;
  updated_at: string;
}

// ============================================================================
// Member Tags Table Definitions
// ============================================================================

/**
 * Organization tag table definition
 * Stores normalized tag definitions per organization
 */
export interface OrganizationTagTable {
  id: string;
  organization_id: string;
  name: string;
  created_at: ColumnType<Date, Date | string, never>;
}

/**
 * Organization tag entity - Runtime representation
 */
export interface OrganizationTag {
  id: string;
  organizationId: string;
  name: string;
  createdAt: Date | string;
}

/**
 * Member tag junction table definition
 * Links members to tags (many-to-many)
 */
export interface MemberTagTable {
  id: string;
  member_id: string;
  tag_id: string;
  created_at: ColumnType<Date, Date | string, never>;
}

/**
 * Member tag entity - Runtime representation
 */
export interface MemberTag {
  id: string;
  memberId: string;
  tagId: string;
  createdAt: Date | string;
}

// ============================================================================
// Projects Table Definitions
// ============================================================================

/**
 * Project UI customization settings
 */
export interface PinnedView {
  connectionId: string;
  toolName: string;
  label: string;
  icon: string | null;
}

export interface ProjectUI {
  banner: string | null;
  bannerColor: string | null;
  icon: string | null;
  themeColor: string | null;
  pinnedViews?: PinnedView[] | null;
}

/**
 * Project table definition
 * Projects are organization-scoped workspaces
 */
export interface ProjectTable {
  id: string;
  organization_id: string;
  slug: string;
  name: string;
  description: string | null;
  enabled_plugins: JsonArray<string> | null;
  ui: JsonObject<ProjectUI> | null;
  created_at: ColumnType<Date, Date | string, never>;
  updated_at: ColumnType<Date, Date | string, Date | string>;
}

/**
 * Project entity - Runtime representation
 */
export interface Project {
  id: string;
  organizationId: string;
  slug: string;
  name: string;
  description: string | null;
  enabledPlugins: string[] | null;
  ui: ProjectUI | null;
  createdAt: Date | string;
  updatedAt: Date | string;
}

/**
 * Project connection join table definition
 * Links projects to organization connections (dependencies)
 */
export interface ProjectConnectionTable {
  id: string;
  project_id: string;
  connection_id: string;
  created_at: ColumnType<Date, Date | string, never>;
}

/**
 * Project connection entity - Runtime representation
 */
export interface ProjectConnection {
  id: string;
  projectId: string;
  connectionId: string;
  createdAt: Date | string;
}

/**
 * Project plugin config table definition
 * Per-project plugin configuration with optional MCP connection binding
 */
export interface ProjectPluginConfigTable {
  id: string;
  project_id: string;
  plugin_id: string;
  connection_id: string | null;
  settings: JsonObject<Record<string, unknown>> | null;
  created_at: ColumnType<Date, Date | string, never>;
  updated_at: ColumnType<Date, Date | string, Date | string>;
}

/**
 * Project plugin config entity - Runtime representation
 */
export interface ProjectPluginConfig {
  id: string;
  projectId: string;
  pluginId: string;
  connectionId: string | null;
  settings: Record<string, unknown> | null;
  createdAt: Date | string;
  updatedAt: Date | string;
}

/**
 * Complete database schema
 * All tables exist within the organization scope (database boundary)
 *
 * NOTE: This uses *Table types with ColumnType for proper Kysely type mapping
 * NOTE: Organizations, teams, members, and roles are managed by Better Auth organization plugin
 */
export interface Database {
  // Core tables (all within organization scope)
  users: UserTable; // System users
  user: BetterAuthUserTable; // Better Auth core table (singular)
  connections: MCPConnectionTable; // MCP connections (organization-scoped)
  organization_settings: OrganizationSettingsTable; // Organization-level configuration
  api_keys: ApiKeyTable; // Better Auth API keys
  monitoring_dashboards: MonitoringDashboardTable; // Custom monitoring dashboards

  // OAuth tables (for MCP OAuth server)
  oauth_clients: OAuthClientTable;
  oauth_authorization_codes: OAuthAuthorizationCodeTable;
  oauth_refresh_tokens: OAuthRefreshTokenTable;
  downstream_tokens: DownstreamTokenTable;

  // Better Auth organization tables (managed by Better Auth plugin)
  organization: BetterAuthOrganizationTable;
  member: BetterAuthMemberTable;
  organizationRole: BetterAuthOrganizationRoleTable;

  // Event bus tables
  events: EventTable;
  event_subscriptions: EventSubscriptionTable;
  event_deliveries: EventDeliveryTable;

  // Connection aggregations (for VIRTUAL connections / agents)
  connection_aggregations: ConnectionAggregationTable;

  threads: ThreadTable;
  thread_messages: ThreadMessageTable;

  // Member tags tables
  organization_tags: OrganizationTagTable;
  member_tags: MemberTagTable;

  // Projects tables
  projects: ProjectTable;
  project_connections: ProjectConnectionTable;
  project_plugin_configs: ProjectPluginConfigTable;

  // AI Provider keys tables
  ai_provider_keys: AIProviderKeyTable;

  // OAuth PKCE state table (short-lived, server-side verifier storage)
  oauth_pkce_states: OAuthPkceStateTable;
}
