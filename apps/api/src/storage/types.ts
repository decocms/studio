/**
 * Database Types for Studio
 *
 * These TypeScript interfaces define the database schema using Kysely's type-only approach.
 * PostgreSQL database schema types.
 *
 * Key Principles:
 * - Database = Organization boundary (all users are org members)
 * - Organizations managed by Better Auth organization plugin
 * - Connections are organization-scoped
 * - Access control via Better Auth permissions and organization roles
 */

import type { ColumnType } from "kysely";
import type { OAuthConfig } from "../tools/connection/schema";
import type { TaskBoardActivityAction } from "../tools/task-board/schema";
import type { ChatMessage } from "../api/routes/decopilot/types";
import type { ProviderId, ThreadStatus } from "@decocms/shared/sdk";
import type {
  OrgFlags,
  UserModelPreferences,
} from "@decocms/shared/organization/schema";
import type { ThreadMetadata } from "@decocms/shared/entities";
import type { PrivateRegistryDatabase } from "./registry/types";

export type {
  OrgSsoConfigPublic,
  ThreadExpandedTool,
  ThreadMetadata,
} from "@decocms/shared/entities";

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

export interface RegistryConfig {
  registries: Record<string, { enabled: boolean }>;
  blockedMcps: string[];
}

export interface SimpleModeModelSlot {
  keyId: string;
  modelId: string;
  title?: string;
}

export type SimpleModeTier =
  | "fast"
  | "smart"
  | "thinking"
  | "image"
  | "web_search"
  | "deep_research";

export interface SimpleModeConfig {
  tiers: Record<SimpleModeTier, SimpleModeModelSlot | null>;
}

export interface UserModelPreferencesTable {
  user_id: string;
  organization_id: string;
  tiers: JsonObject<UserModelPreferences["tiers"]>;
  created_at: ColumnType<Date, Date | string, never>;
  updated_at: ColumnType<Date, Date | string, Date | string>;
}

export interface DefaultHomeAgentsConfig {
  ids: string[];
}

export interface OrganizationSettingsTable {
  organizationId: string;
  sidebar_items: JsonArray<SidebarItem[]> | null;
  enabled_plugins: JsonArray<string[]> | null;
  registry_config: JsonObject<RegistryConfig> | null;
  simple_mode: JsonObject<SimpleModeConfig> | null;
  default_home_agents: JsonObject<DefaultHomeAgentsConfig> | null;
  // Boolean toggles bag — the flag set lives in OrgFlagsSchema
  // (@decocms/shared/organization/schema); updates shallow-merge.
  flags: JsonObject<OrgFlags> | null;
  // Virtual MCP id the org lands on (`/$org`) instead of the Super Agent.
  main_agent_id: string | null;
  createdAt: ColumnType<Date, Date | string, never>;
  updatedAt: ColumnType<Date, Date | string, Date | string>;
}

export interface OrganizationSettings {
  organizationId: string;
  sidebar_items: SidebarItem[] | null;
  enabled_plugins: string[] | null;
  registry_config: RegistryConfig | null;
  simple_mode: SimpleModeConfig | null;
  default_home_agents: DefaultHomeAgentsConfig | null;
  flags: OrgFlags | null;
  main_agent_id: string | null;
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
  slug: string | null;

  // Connection details
  connection_type: "HTTP" | "SSE" | "Websocket" | "STDIO" | "VIRTUAL";
  connection_url: string | null; // Null for STDIO, virtual://$id for VIRTUAL
  connection_token: string | null; // Encrypted
  connection_headers: string | null; // JSON - encrypted envVars for STDIO

  // OAuth config for downstream MCP (if MCP supports OAuth)
  oauth_config: JsonObject<OAuthConfig> | null;

  // Connection-provided configuration state
  configuration_state: string | null; // Encrypted JSON state
  configuration_scopes: JsonArray<string[]> | null; // Array of scope strings

  // Metadata and discovery
  metadata: JsonObject<Record<string, unknown>> | null;
  bindings: JsonArray<string[]> | null; // Detected bindings (CHAT, EMAIL, etc.)

  status: "active" | "inactive" | "error";
  pinned: boolean;
  created_at: ColumnType<Date, Date | string, never>;
  updated_at: ColumnType<Date, Date | string, Date | string>;
}

// MCPConnection runtime type is now ConnectionEntity from "../tools/connection/schema"
// OAuthConfig is also exported from schema.ts

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
  key_hash: string | null; // SHA-256 of the plaintext key; null for legacy rows
  /**
   * Frontend-controlled subtype for grouping keys under branded preset cards
   * (e.g. "litellm", "ollama" all map to provider_id = "openai-compatible").
   * Null for non-preset keys.
   */
  preset_id: string | null;
  created_by: string;
  created_at: ColumnType<Date, Date | string, never>;
}

/** Public DTO for an AI provider key — never exposes the encrypted key. */
export interface ProviderKeyInfo {
  id: string;
  providerId: ProviderId;
  label: string;
  presetId: string | null;
  organizationId: string;
  createdBy: string;
  createdAt: string;
}

export type SecretScopeKind = "user" | "organization";

export interface SecretTable {
  id: string;
  organization_id: string;
  scope: SecretScopeKind;
  user_id: string | null;
  name: string;
  encrypted_value: string;
  description: string | null;
  created_by: string;
  created_at: ColumnType<Date, Date | string, never>;
  updated_by: string;
  updated_at: ColumnType<Date, Date | string, Date | string>;
}

/** Public DTO for a secret — never exposes the encrypted value. */
export interface SecretInfo {
  id: string;
  organizationId: string;
  scope: SecretScopeKind;
  userId: string | null;
  name: string;
  description: string | null;
  createdBy: string;
  createdAt: string;
  updatedBy: string;
  updatedAt: string;
}

/**
 * Org-scoped S3-compatible bucket configuration. Stores connection metadata
 * plus an encrypted JSON blob holding the access key / secret key pair.
 * `endpoint` and `force_path_style` support non-AWS S3 (R2, MinIO, GCS).
 */
export interface OrgFileConfigTable {
  id: string;
  organization_id: string;
  name: string;
  description: string | null;
  bucket: string;
  region: string;
  endpoint: string | null;
  force_path_style: ColumnType<boolean, boolean | undefined, boolean>;
  prefix: string | null;
  // Public URL host (e.g. R2 dev domain, CDN). Null = compute from bucket+region.
  public_url_base: string | null;
  // "static" (long-lived key pair in encrypted_credentials), "sts-session"
  // (temporary creds fetched on demand from refresh_url; the encrypted blob
  // holds only the API key for the refresh call), or "managed" (no stored
  // secret — studio mints prefix-scoped STS creds in-process for `site_slug`,
  // authorized by org_sites ownership). Has a DB default of 'static'.
  credential_type: ColumnType<
    "static" | "sts-session" | "managed",
    "static" | "sts-session" | "managed" | undefined,
    "static" | "sts-session" | "managed"
  >;
  // Endpoint that vends temporary credentials for `sts-session` configs. Null
  // for `static` / `managed`.
  refresh_url: string | null;
  // Site slug a `managed` config mints credentials for (its `<slug>/` prefix on
  // the shared tenant bucket). Null for `static` / `sts-session`.
  site_slug: string | null;
  encrypted_credentials: string;
  created_by: string;
  created_at: ColumnType<Date, Date | string, never>;
  updated_by: string;
  updated_at: ColumnType<Date, Date | string, Date | string>;
}

/**
 * Org filesystem manifest row. Indexes the org-prefixed object-storage
 * keyspace under `_fs/{volume}/...` with path/tree semantics. Bytes live in
 * object storage; this carries metadata + the change-feed cursor (`seq`) and
 * conflict oracle (`content_hash`). See `.context/org-filesystem-proposal.md`.
 */
export interface OrgFsEntryTable {
  organization_id: string;
  volume: string;
  /** Normalized path, no leading/trailing slash. "" is the volume root. */
  path: string;
  /** Parent directory path ("" for top-level). Drives listDir. */
  parent: string;
  kind: "file" | "dir";
  /** sha256 of the bytes for files; null for dirs. */
  content_hash: string | null;
  // bigint columns come back from pg as strings; coerce in the storage layer.
  size: ColumnType<string, string | number | undefined, string | number>;
  seq: ColumnType<string, string | number | undefined, string | number>;
  deleted_at: ColumnType<
    Date | null,
    Date | string | null | undefined,
    Date | string | null
  >;
  created_by: string;
  created_at: ColumnType<Date, Date | string | undefined, never>;
  updated_by: string;
  updated_at: ColumnType<Date, Date | string | undefined, Date | string>;
  /** Chat/run that last wrote this file; null for writes not tied to a
   *  dispatch (mount write-backs, backfill). Scopes live deck previews to
   *  the originating chat. */
  thread_id: string | null;
  /** When true, the `/fs/:volume/read` proxy serves this entry to anyone — no
   *  auth, no org membership. On a dir it publishes the whole subtree (reads
   *  inherit from a published ancestor). Defaults to false (org-only).
   *  Preserved across in-place overwrites; reset to false on delete + recreate. */
  read_public: ColumnType<boolean, boolean | undefined, boolean>;
  /** scrypt hash of the share password. Null on a published entry = fully
   *  public; set = the proxy serves a password form first. Never sent to
   *  clients. Meaningless unless `read_public`. */
  share_password_hash: string | null;
  /** Random per-node token mixed into unlock-cookie signatures; rotated on
   *  every password change so old cookies stop validating. Null when not
   *  password-protected. */
  share_secret: string | null;
}

/** Public DTO for a file config — never exposes access key / secret key. */
export interface FileConfigInfo {
  id: string;
  organizationId: string;
  name: string;
  description: string | null;
  bucket: string;
  region: string;
  endpoint: string | null;
  forcePathStyle: boolean;
  prefix: string | null;
  publicUrlBase: string | null;
  credentialType: "static" | "sts-session" | "managed";
  refreshUrl: string | null;
  siteSlug: string | null;
  createdBy: string;
  createdAt: string;
  updatedBy: string;
  updatedAt: string;
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

/** A user's linked Claude subscription token (migration 162). */
export interface ClaudeSubscriptionTable {
  user_id: string;
  encrypted_access_token: string;
  /** Null when the pasted token carries no readable expiry. */
  expires_at: ColumnType<
    Date | null,
    Date | string | null,
    Date | string | null
  >;
  created_at: ColumnType<Date, Date | string, Date | string>;
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

export interface ConnectionWorkloadTokenTable {
  id: string;
  organization_id: string;
  subject_connection_id: string;
  token_hash: string;
  token_prefix: string;
  name: string;
  revoked_at: ColumnType<Date, Date | string, Date | string> | null;
  last_used_at: ColumnType<Date, Date | string, Date | string> | null;
  created_at: ColumnType<Date, Date | string | undefined, never>;
  updated_at: ColumnType<Date, Date | string | undefined, Date | string>;
}

export interface ConnectionCredentialGrantTable {
  id: string;
  organization_id: string;
  subject_connection_id: string;
  target_connection_id: string;
  scope: string;
  created_by: string;
  created_at: ColumnType<Date, Date | string | undefined, never>;
  updated_at: ColumnType<Date, Date | string | undefined, Date | string>;
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
// Organization SSO Table Definitions
// ============================================================================

/**
 * OIDC SSO provider configuration per organization
 */
export interface OrgSsoConfigTable {
  id: string;
  organization_id: string;
  issuer: string;
  client_id: string;
  client_secret: string; // Encrypted via vault
  discovery_endpoint: string | null;
  scopes: string; // JSON array
  domain: string; // Email domain (e.g. "company.com")
  enforced: number; // 0 or 1
  created_at: ColumnType<Date, Date | string, never>;
  updated_at: ColumnType<Date, Date | string, Date | string>;
}

/**
 * Organization SSO config - Runtime representation
 */
export interface OrgSsoConfig {
  id: string;
  organizationId: string;
  issuer: string;
  clientId: string;
  clientSecret: string; // Decrypted
  discoveryEndpoint: string | null;
  scopes: string[];
  domain: string;
  enforced: boolean;
  createdAt: Date | string;
  updatedAt: Date | string;
}

/**
 * Sanitized SSO config for API responses (no secrets)
 */
/**
 * Per-user SSO authentication session per organization
 */
export interface OrgSsoSessionTable {
  id: string;
  user_id: string;
  organization_id: string;
  authenticated_at: string;
  expires_at: string;
  created_at: ColumnType<Date, Date | string, never>;
}

/**
 * Organization SSO session - Runtime representation
 */
export interface OrgSsoSession {
  id: string;
  userId: string;
  organizationId: string;
  authenticatedAt: string;
  expiresAt: string;
  createdAt: Date | string;
}

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
  toolName: string;
  input: Record<string, unknown>;
  output: Record<string, unknown>;
  isError: boolean;
  errorMessage?: string | null;
  durationMs: number;
  timestamp: Date | string;
  userId: string | null;
  requestId: string;
  userAgent?: string | null; // x-studio-client header
  virtualMcpId?: string | null; // Virtual MCP (Agent) ID if routed through an agent
  properties?: Record<string, string> | null; // Custom key-value metadata
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
  enabled: boolean;
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

/** Stored thread statuses (persisted in DB). Canonical source: @decocms/shared/sdk */
export type { ThreadStatus } from "@decocms/shared/sdk";

export interface ThreadTable {
  id: string;
  organization_id: string;
  title: string;
  description: string | null;
  hidden: boolean | null;
  status: ThreadStatus;
  trigger_id: string | null;
  context_start_message_id: string | null;
  run_owner_pod: string | null;
  run_config: ColumnType<
    Record<string, unknown> | null,
    string | null,
    string | null
  >;
  run_started_at: ColumnType<
    Date | null,
    Date | string | null,
    Date | string | null
  >;
  /** Virtual MCP (agent) this thread was initiated with */
  virtual_mcp_id: string;
  /** Git branch this thread is pinned to (GitHub-linked virtualmcps only) */
  branch: string | null;
  /** Sandbox provider kind pinned on first message (e.g. "agent-sandbox", "user-desktop") */
  sandbox_provider_kind: string | null;
  /** Harness id pinned on first message (e.g. "claude-code", "codex", "decopilot") */
  harness_id: string | null;
  /** Per-task UI state (e.g., expanded_tools for right-panel tabs) */
  metadata: ColumnType<ThreadMetadata, string | undefined, string>;
  created_at: ColumnType<Date, Date | string, never>;
  updated_at: ColumnType<Date, Date | string, Date | string>;
  created_by: string; // User ID;
  updated_by: string | null;
  message_storage_version: ColumnType<number, number | undefined, number>;
  last_progress_at: ColumnType<
    Date | null,
    Date | string | null,
    Date | string | null
  >;
  /** Single-writer fence for the active run; null when none minted (Phase A). */
  run_fence_token: ColumnType<string | null, string | null, string | null>;
  /**
   * @deprecated Per-thread transport selector. No longer read for routing —
   * the thread gate uses the active link publisher whenever NATS and the link
   * dispatch runtime are available (see thread-gate-workflow.ts). The writer
   * (`setLinkTransport`) was removed with the cluster reverse-WS cleanup.
   * Column retained (nullable) for backward compatibility; no drop migration.
   * New code MUST NOT read or write it.
   */
  link_transport: ColumnType<string | null, string | null, string | null>;
  /**
   * Durable cancel flag (Phase C). Set by the cancel endpoint; the ingest
   * backstop rejects with 409 when non-null, regardless of fence state.
   * Null = no cancel requested; non-null timestamp = cancel was requested.
   */
  cancel_requested_at: ColumnType<
    Date | null,
    Date | string | null,
    Date | string | null
  >;
  /**
   * Human-readable reason the run was marked failed (e.g. the error message
   * from the harness or the projector). Null for runs that completed normally
   * or were failed without a reason (pre-migration rows).
   */
  failure_reason: string | null;
  /**
   * Coarse failure category. One of "harness" | "projection" | "transport" |
   * "liveness" | "stall" (the last written only by the progress-based reaper,
   * `run-registry.ts`; "liveness" is the consume-side subject-silence
   * terminal — see `projector-workflow.ts`'s `livenessFailureReason`).
   * Null for pre-migration rows or runs failed without kind information.
   */
  failure_kind: string | null;
  /**
   * Highest contiguous publish-confirmed seq for the active run. Written via a
   * monotonic CAS (only advances, never regresses). Null for pre-existing rows
   * and runs that haven't published a chunk yet. Cleared implicitly when a new
   * run resets the floor at the call site (fence epoch change).
   */
  run_acked_seq: number | null;
}

export interface Thread {
  id: string;
  organization_id: string;
  title: string;
  description: string | null;
  created_at: string;
  updated_at: string;
  created_by: string;
  updated_by: string | undefined;
  hidden: boolean | null;
  status: ThreadStatus;
  trigger_id: string | null;
  context_start_message_id: string | null;
  run_owner_pod: string | null;
  run_config: Record<string, unknown> | null;
  run_started_at: string | null;
  /**
   * Progress-liveness heartbeat, bumped per streamed chunk (throttled). Used to
   * derive the virtual "expired" status while a run is streaming — the same
   * signal the reaper trusts — so a still-streaming thread never shows expired.
   * Null when the run has never streamed a chunk.
   */
  last_progress_at: string | null;
  /** Virtual MCP (agent) this thread was initiated with */
  virtual_mcp_id: string;
  /** Git branch this thread is pinned to (GitHub-linked virtualmcps only) */
  branch: string | null;
  /** Sandbox provider kind pinned on first message (e.g. "agent-sandbox", "user-desktop") */
  sandbox_provider_kind: string | null;
  /** Harness id pinned on first message (e.g. "claude-code", "codex", "decopilot") */
  harness_id: string | null;
  metadata: ThreadMetadata;
  /**
   * Message storage format for this thread's history.
   * 1 = legacy `thread_messages` rows (folded server-side as whole messages).
   * 2 = `thread_message_parts` stream-of-record (folded via `foldParts`).
   * Pinned on the thread row; read path forks on this value.
   */
  message_storage_version: number;
  /**
   * @deprecated No longer used for routing (see the `threads` table column
   * doc). Surfaced on the read path for backward compatibility only; nothing
   * writes it. New code MUST NOT depend on it.
   */
  link_transport: string | null;
}

/**
 * Lifecycle states for a single async research job.
 *
 * pending   — row inserted, provider job not yet submitted (rare; the gap
 *             between INSERT and the submit call).
 * polling   — submitted to the provider, driving to terminal state.
 * completed — provider returned a final report.
 * failed    — provider reported terminal failure.
 * cancelled — user aborted; provider job (best-effort) cancelled too.
 * abandoned — sweeper flipped a stale polling row whose `last_polled_at`
 *             is older than the staleness threshold. Visible in audit logs;
 *             contrast with the old approach that silently filtered stale
 *             rows at read time.
 */
const ASYNC_RESEARCH_JOB_STATUSES = [
  "pending",
  "polling",
  "completed",
  "failed",
  "cancelled",
  "abandoned",
] as const;
export type AsyncResearchJobStatus =
  (typeof ASYNC_RESEARCH_JOB_STATUSES)[number];

export interface AsyncResearchJobCitation {
  url: string;
  title?: string;
}

export interface AsyncResearchJobTable {
  id: ColumnType<string, string | undefined, never>;
  interaction_id: string | null;
  tool_call_id: string;

  organization_id: string;
  thread_id: string;
  message_id: string | null;

  provider: string;
  model_id: string;
  query: string;

  status: AsyncResearchJobStatus;
  attempts: number;
  last_polled_at: ColumnType<
    Date | null,
    Date | string | null,
    Date | string | null
  >;
  last_error: string | null;

  input_tokens: number | null;
  output_tokens: number | null;
  citations: JsonArray<AsyncResearchJobCitation> | null;
  result_uri: string | null;
  result_preview: string | null;
  /**
   * Full report text for inline-sized completed jobs. NULL when the
   * report was offloaded to blob storage via `result_uri`. Drives the
   * replay path so a re-entry with the same tool_call_id returns the
   * exact original content (not the truncated preview).
   */
  result_content: string | null;

  created_at: ColumnType<Date, Date | string | undefined, never>;
  updated_at: ColumnType<Date, Date | string, Date | string>;
  completed_at: ColumnType<
    Date | null,
    Date | string | null,
    Date | string | null
  >;
}

/** Runtime representation of an async research job (decoded JSON columns). */
export interface AsyncResearchJob {
  id: string;
  interactionId: string | null;
  toolCallId: string;

  organizationId: string;
  threadId: string;
  messageId: string | null;

  provider: string;
  modelId: string;
  query: string;

  status: AsyncResearchJobStatus;
  attempts: number;
  lastPolledAt: string | null;
  lastError: string | null;

  inputTokens: number | null;
  outputTokens: number | null;
  citations: AsyncResearchJobCitation[] | null;
  resultUri: string | null;
  resultPreview: string | null;
  resultContent: string | null;

  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
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

export type PartKind =
  | "text"
  | "reasoning"
  | "tool_call"
  | "tool_result"
  | "file"
  | "error"
  | "finish";

export interface ThreadMessagePartTable {
  id: string; // "<run_id>:<message_id>:<seq>"
  seq: number; // integer, monotonic per message
  org_id: string;
  thread_id: string;
  run_id: string;
  message_id: string;
  role: "user" | "assistant" | "system";
  kind: PartKind;
  payload: unknown; // jsonb
  payload_ref: string | null;
  metadata: unknown | null; // jsonb
  created_at: string; // ISO; derived from durable seq order, NOT now+i
  /**
   * Wall clock at INSERT, stamped by Postgres (migration 174). `created_at` is
   * an ordering key (`base + seq`), so it cannot answer "when did this row
   * actually land" — this can. Never insertable/updatable: the default is the
   * only writer, which is what keeps it honest. NULL on rows predating 174.
   */
  persisted_at: ColumnType<Date | null, never, never>;
}

// ============================================================================
// Member Tags Table Definitions
// ============================================================================

/** Per-org subsidy gateway key (migration 159) — vault-encrypted; see
 *  storage/subsidized-gateway-keys.ts. */
export interface SubsidizedGatewayKeyTable {
  organization_id: string;
  encrypted_key: string;
  created_at: ColumnType<Date, Date | string | undefined, never>;
}

/** Quota ledger for reports-pushed task executions (migration 158) — one
 *  claim per task, bucketed by period_key (see billing/task-quota.ts). */
/** `held` = charged (counts toward the period); `released` = refunded
 *  because the run produced nothing. A union, so a typo in a comparison is a
 *  compile error rather than a silent money decision. */
export type TaskQuotaClaimState = "held" | "released";

export interface TaskQuotaClaimTable {
  task_board_item_id: string;
  organization_id: string;
  period_key: string;
  /** Dispatches funded by this claim — capped at STUDIO_MAX_RUNS_PER_TASK so
   *  one claim can't fund a re-delegation loop. Survives a release, so
   *  releasing is never a free reset. */
  run_count: ColumnType<number, number | undefined, number>;
  /** Charge state — see TaskQuotaClaimState. */
  state: ColumnType<
    TaskQuotaClaimState,
    TaskQuotaClaimState,
    TaskQuotaClaimState
  >;
  created_at: ColumnType<Date, Date | string | undefined, never>;
}

/** Per-org billing identity (migration 139). Platform-written only —
 *  never writable by org members. */
export interface OrganizationBillingTable {
  organization_id: string;
  /** Subscription status: "none" | "active" | "past_due" | "canceled". */
  status: ColumnType<string, string | undefined, string>;
  stripe_customer_id: ColumnType<
    string | null,
    string | null | undefined,
    string | null
  >;
  stripe_subscription_id: ColumnType<
    string | null,
    string | null | undefined,
    string | null
  >;
  current_period_end: ColumnType<
    Date | null,
    Date | string | null | undefined,
    Date | string | null
  >;
  /** High-water mark of the newest applied Stripe event's `created` time
   *  (migration 142) — older webhook deliveries are skipped, so out-of-order
   *  redeliveries can never regress subscription state. */
  last_stripe_event_at: ColumnType<
    Date | null,
    Date | string | null | undefined,
    Date | string | null
  >;
  /** Per-org allowances (migration 164) overriding the deployment-wide
   *  `STUDIO_FREE_TASKS` / `STUDIO_MONTHLY_TASKS`. NULL = use the default.
   *  Operator-set only — never writable through a tool, or an org admin could
   *  raise its own limit. */
  free_task_executions: ColumnType<
    number | null,
    number | null | undefined,
    number | null
  >;
  monthly_task_executions: ColumnType<
    number | null,
    number | null | undefined,
    number | null
  >;
  created_at: ColumnType<Date, Date | string | undefined, never>;
  updated_at: ColumnType<Date, Date | string | undefined, Date | string>;
}

/**
 * Organization tag table definition
 * Stores normalized tag definitions per organization
 */
export interface OrganizationTagTable {
  id: string;
  organization_id: string;
  name: string;
  /** Hex color (e.g. "#3b82f6") the tag renders its dot with. Null pre-dates
   *  task-board tags, which is the only place color is set today. */
  color: string | null;
  created_at: ColumnType<Date, Date | string, never>;
}

/**
 * Organization tag entity - Runtime representation
 */
export interface OrganizationTag {
  id: string;
  organizationId: string;
  name: string;
  color: string | null;
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
// Virtual MCP Plugin Config Table Definition
// ============================================================================

/**
 * Virtual MCP plugin config table definition
 * Per-virtual-MCP plugin configuration with optional MCP connection binding
 */
export interface VirtualMcpPluginConfigTable {
  id: string;
  virtual_mcp_id: string;
  plugin_id: string;
  connection_id: string | null;
  settings: JsonObject<Record<string, unknown>> | null;
  created_at: ColumnType<Date, Date | string, never>;
  updated_at: ColumnType<Date, Date | string, Date | string>;
}

// ============================================================================
// Automations Table Definitions
// ============================================================================

/**
 * Automation table definition
 * Stores automation configurations with agent, messages, and model settings
 */
export interface AutomationTable {
  id: string;
  organization_id: string;
  name: string;
  active: boolean;
  created_by: string;
  messages: string;
  models: string;
  // JSON-encoded string[] of model-facing tool names the run is restricted to.
  // null = all of the bound agent's tools (default / pre-existing behavior).
  tools: string | null;
  temperature: number;
  // Parent agent-loop step cap (AI SDK stopWhen). null = PARENT_STEP_LIMIT.
  max_agent_steps: number | null;
  virtual_mcp_id: string;
  created_at: ColumnType<Date, Date | string, never>;
  updated_at: ColumnType<Date, Date | string, Date | string>;
}

/**
 * Automation entity - Runtime representation
 */
export interface Automation {
  id: string;
  organization_id: string;
  name: string;
  active: boolean;
  created_by: string;
  messages: string;
  models: string;
  tools: string | null;
  temperature: number;
  max_agent_steps: number | null;
  virtual_mcp_id: string;
  created_at: string;
  updated_at: string;
}

/**
 * Automation trigger table definition
 * Defines when automations should run (cron or event-based)
 */
export interface AutomationTriggerTable {
  id: string;
  automation_id: string;
  type: string;
  cron_expression: string | null;
  connection_id: string | null;
  event_type: string | null;
  params: string | null; // JSON string
  last_run_at: ColumnType<
    Date | null,
    Date | string | null,
    Date | string | null
  >;
  next_run_at: ColumnType<
    Date | null,
    Date | string | null,
    Date | string | null
  >;
  // For webhook triggers: Better Auth apikey.id used to authenticate POSTs.
  // Null for cron/event triggers.
  api_key_id: string | null;
  created_at: ColumnType<Date, Date | string, never>;
}

/**
 * Automation trigger entity - Runtime representation
 */
export interface AutomationTrigger {
  id: string;
  automation_id: string;
  type: "cron" | "event" | "webhook";
  cron_expression: string | null;
  connection_id: string | null;
  event_type: string | null;
  params: string | null;
  last_run_at: string | null;
  next_run_at: string | null;
  api_key_id: string | null;
  created_at: string;
}

/**
 * Trigger callback token table - stores hashed tokens for external MCP callbacks
 */
export interface TriggerCallbackTokenTable {
  id: string;
  organization_id: string;
  connection_id: string;
  token_hash: string;
  created_at: ColumnType<Date, Date | string, never>;
}

export interface KVTable {
  organization_id: string;
  key: string;
  value: JsonObject<Record<string, unknown>>;
  updated_at: ColumnType<Date, Date | string, Date | string>;
}

export interface SandboxProviderStateTable {
  user_id: string;
  project_ref: string;
  sandbox_provider_kind: string;
  handle: string;
  state: JsonObject<Record<string, unknown>>;
  updated_at: ColumnType<Date, Date | string, Date | string>;
}

// ============================================================================
// Organization Domain Table Definition
// ============================================================================

export type DomainJoinMode = "off" | "auto" | "request";
export type DomainVerificationStatus = "pending" | "verified";
export type DomainVerificationMethod = "email" | "dns";

export interface OrganizationDomainTable {
  id: string;
  organization_id: string;
  domain: string;
  join_mode: DomainJoinMode;
  verification_status: DomainVerificationStatus;
  verification_method: DomainVerificationMethod | null;
  verification_token: string | null;
  verified_at: ColumnType<
    Date | null,
    Date | string | null,
    Date | string | null
  >;
  created_at: ColumnType<Date, Date | string, never>;
  updated_at: ColumnType<Date, Date | string, Date | string>;
}

export interface OrganizationDomain {
  id: string;
  organizationId: string;
  domain: string;
  joinMode: DomainJoinMode;
  verificationStatus: DomainVerificationStatus;
  verificationMethod: DomainVerificationMethod | null;
  verificationToken: string | null;
  verifiedAt: Date | string | null;
  createdAt: Date | string;
  updatedAt: Date | string;
}

export type JoinRequestStatus = "pending" | "approved" | "denied";

export interface OrganizationJoinRequestTable {
  id: string;
  organization_id: string;
  user_id: string;
  status: JoinRequestStatus;
  decided_by: string | null;
  decided_at: ColumnType<
    Date | null,
    Date | string | null,
    Date | string | null
  >;
  created_at: ColumnType<Date, Date | string, never>;
  updated_at: ColumnType<Date, Date | string, Date | string>;
}

export interface OrganizationJoinRequest {
  id: string;
  organizationId: string;
  userId: string;
  status: JoinRequestStatus;
  decidedBy: string | null;
  decidedAt: Date | string | null;
  createdAt: Date | string;
  updatedAt: Date | string;
}

// ============================================================================
// Org Sites (asset tenancy: org owns globally-unique site slugs)
// ============================================================================

export interface OrgSiteTable {
  // Globally-unique site slug = object-key prefix namespace in the shared
  // tenant bucket. Primary key enforces global uniqueness across orgs.
  slug: string;
  organization_id: string;
  // Provenance of the claim: 'deco-import' (migrated) or 'manual'.
  source: ColumnType<string, string | undefined, string>;
  created_by: string;
  created_at: ColumnType<Date, Date | string | undefined, never>;
  updated_by: string;
  updated_at: ColumnType<Date, Date | string | undefined, Date | string>;
}

export interface OrgSite {
  slug: string;
  organizationId: string;
  source: string;
  createdBy: string;
  createdAt: string;
  updatedBy: string;
  updatedAt: string;
}

// ============================================================================
// Org Repo Sync (per-org GitHub repo → org-fs volume mirror)
// ============================================================================

export interface OrgRepoSyncTable {
  id: ColumnType<string, string | undefined, never>;
  organization_id: string;
  /** Repo-scoped `mcp-github` connection the sync mints tokens from. */
  connection_id: string;
  repo_owner: string;
  repo_name: string;
  ref: ColumnType<string, string | undefined, string>;
  /** Same shape as PublicSkillSetSource.paths: [{from, to?}]. */
  paths: ColumnType<
    Array<{ from: string; to?: string }>,
    string | undefined,
    string
  >;
  volume: string;
  enabled: ColumnType<boolean, boolean | undefined, boolean>;
  last_synced_at: ColumnType<Date | null, never, Date | string | null>;
  last_sync_error: ColumnType<string | null, never, string | null>;
  created_by: string;
  created_at: ColumnType<Date, Date | string | undefined, never>;
  updated_at: ColumnType<Date, Date | string | undefined, Date | string>;
}

export interface OrgRepoSync {
  id: string;
  organizationId: string;
  connectionId: string;
  repoOwner: string;
  repoName: string;
  ref: string;
  paths: Array<{ from: string; to?: string }>;
  volume: string;
  enabled: boolean;
  lastSyncedAt: string | null;
  lastSyncError: string | null;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

export type TaskBoardItemStatus =
  | "triage"
  | "todo"
  | "in_progress"
  | "in_review"
  | "done"
  | "archived";

export type TaskBoardItemPriority =
  | "none"
  | "low"
  | "medium"
  | "high"
  | "urgent";

export interface TaskBoardItemTable {
  id: string;
  organization_id: string;
  title: string;
  description: string | null;
  status: ColumnType<
    TaskBoardItemStatus,
    TaskBoardItemStatus | undefined,
    string
  >;
  priority: ColumnType<
    TaskBoardItemPriority,
    TaskBoardItemPriority | undefined,
    string
  >;
  assignee_id: string | null;
  assigned_by: string | null;
  repo: string | null;
  due_date: ColumnType<
    Date | null,
    Date | string | null | undefined,
    Date | string | null
  >;
  /** Sender-minted finding identity (e.g. `diag:{domain}:{check_id}`) — the
   *  import refreshes an OPEN item with the same key instead of duplicating
   *  it. Null for human-created cards. */
  external_key: ColumnType<
    string | null,
    string | null | undefined,
    string | null
  >;
  /** Set when a reports-pushed finding's card is dismissed (its "delete") —
   *  the card leaves the board and the import skips its `external_key`, so the
   *  finding doesn't return on the next scan. Null for a live card. Cleared by
   *  `TASK_BOARD_DISMISSED_RESTORE`. */
  dismissed_at: ColumnType<
    Date | null,
    Date | string | null | undefined,
    Date | string | null
  >;
  /** Manual drag-to-reorder position within a lane, ascending. */
  sort_order: ColumnType<number, number | undefined, number>;
  /** Per-org sequence behind the card's human key (`DECO-01`), assigned once at
   *  create. Never null (enforced by migration 172). */
  key_seq: ColumnType<number, number | undefined, never>;
  /** When the review sweeper last reconciled this card. Null = never, which is
   *  always due. The sweeper's interval hangs off this column rather than off
   *  its own timer so that every replica shares one budget and a permanently
   *  parked card costs one GitHub round-trip per interval, not one per tick —
   *  see `migrations/166-task-board-last-swept-at.ts`. Not `updated_at`: a
   *  sweep is not a user-visible edit. */
  last_swept_at: ColumnType<
    Date | null,
    Date | string | null | undefined,
    Date | string | null
  >;
  /** When this card is next due for an automatic re-dispatch after its run
   *  failed on infrastructure. Null = not waiting on a retry. Lives on the row
   *  so the schedule survives a pod restart — see
   *  `migrations/167-task-board-run-retry.ts`. */
  retry_at: ColumnType<
    Date | null,
    Date | string | null | undefined,
    Date | string | null
  >;
  /** How many infrastructure retries this card has already spent. Counted on
   *  the card, not the thread: each attempt is a NEW thread, so a per-thread
   *  counter would reset every time and never exhaust. */
  retry_attempts: ColumnType<number, number | undefined, number>;
  created_by: string;
  created_at: ColumnType<Date, Date | string | undefined, never>;
  updated_by: string;
  updated_at: ColumnType<Date, Date | string | undefined, Date | string>;
}

/** One processed task-board import request: PK (organization_id, run_id).
 *  Claimed inside the import's transaction — a replay of the same run (the
 *  reports worker's payment success page and Stripe webhook both push) loses
 *  the claim and no-ops instead of duplicating the board. */
export interface TaskBoardImportRunTable {
  organization_id: string;
  run_id: string;
  created_at: ColumnType<Date, Date | string | undefined, never>;
}

/** Join row: a task board item ↔ an agent thread (many-to-many). */
export interface TaskBoardItemThreadTable {
  task_board_item_id: string;
  thread_id: string;
  organization_id: string;
  created_at: ColumnType<Date, Date | string | undefined, never>;
}

/** Join row: a task board item ↔ a GitHub pull request an agent opened for it. */
export interface TaskBoardItemPrTable {
  task_board_item_id: string;
  organization_id: string;
  url: string;
  pr_number: number;
  repo_owner: string;
  repo_name: string;
  /** Source GitHub MCP connection, when the PR was opened via MCP. Null for
   *  bash-opened PRs — the live fetcher falls back to the org's shared conn. */
  connection_id: string | null;
  created_at: ColumnType<Date, Date | string | undefined, never>;
}

/** One comment on a task. `parent_id` NULL means a thread root; a reply always
 *  points at a root (one level only). `resolved` is a thread property, so it is
 *  only meaningful on roots. Org scope comes from the task. */
export interface TaskBoardCommentTable {
  id: string;
  task_board_item_id: string;
  parent_id: string | null;
  author_id: string;
  body: string;
  resolved: ColumnType<boolean, boolean | undefined, boolean>;
  created_at: ColumnType<Date, Date | string | undefined, never>;
  updated_at: ColumnType<Date, Date | string | undefined, Date | string>;
}

/** One review claim: a (task, reviewer, review-cycle) slot, minted at reviewer
 *  dispatch. The primary key dedups concurrent enqueues; `token` binds the
 *  reviewer's decision back to the run that was dispatched. */
export interface TaskBoardReviewClaimTable {
  task_board_item_id: string;
  reviewer: string;
  cycle_at: ColumnType<Date, Date | string, never>;
  token: string;
  created_at: ColumnType<Date, Date | string | undefined, never>;
}

/** Join row: a task board item ↔ an org tag (many-to-many). `id` is the tag's
 *  id; both sides are org-scoped already, so the join carries no org column. */
export interface TaskBoardItemTagTable {
  task_board_item_id: string;
  id: string;
  created_by: string;
  created_at: ColumnType<Date, Date | string | undefined, never>;
}

/** A tag attached to a task, snapshotted for rendering (name/color can change
 *  independently of the task), plus who attached it and when. */
export interface TaskBoardItemTagRef {
  id: string;
  name: string;
  color: string | null;
  createdBy: string;
  createdAt: string;
}

/** A PR linked to a task — identity only. Title/state are fetched live. */
export interface TaskBoardItemPrRef {
  url: string;
  number: number;
  repoOwner: string;
  repoName: string;
  connectionId: string | null;
  createdAt: string;
}

/** A thread linked to a task, with the run state the board needs to render it. */
export interface TaskBoardItemThreadRef {
  threadId: string;
  /** Owning agent — needed to open the thread's chat. */
  virtualMcpId: string | null;
  status: ThreadStatus | null;
  title: string | null;
  /** Latest assistant text, for the card's one-line activity preview. */
  lastMessage: string | null;
  /** True when a repo is bound to the thread (`metadata.githubRepo`) — the
   *  card opens the live dev Preview instead of staying on the board. */
  hasPreview: boolean;
  /** `threads.failure_kind` — null unless `status` is `failed`. Some kinds mean
   *  the failure is settled history rather than the task's outcome; see
   *  `isResolvedRunFailure`. */
  failureKind: string | null;
  /** True when the thread has at least one message in either storage format.
   *  False means it was created and never used — clicking "New chat" persists
   *  the row up-front, and `create` defaults `status` to "completed", so such a
   *  thread looks finished without ever having run. Status alone can't tell the
   *  two apart; see `shouldAdvanceToReview`. */
  hasMessages: boolean;
  /** Newest of the thread's `updated_at` / `last_progress_at` — the same
   *  heartbeat the stall reaper trusts. A non-terminal thread whose heartbeat
   *  went cold is not running, whatever its status says; see
   *  `reviewerHandledThisCycle`. */
  lastActiveAt: string;
  /** What this run has cost so far, in USD, summed from the usage the harness
   *  recorded on each assistant message. `null` when nothing is recorded yet
   *  (a run that has not finished a message, or a harness that reports no
   *  cost) — which is NOT the same as zero. An estimate the provider reported,
   *  never a billed amount. */
  costUsd: number | null;
  /** Which provider `costUsd` was spent against (`claude-subscription`,
   *  `openrouter`, …). `null` when unrecorded, or when the run's steps did not
   *  all agree — the board turns this into a claim about whose money paid, so
   *  a mixed run must read as unknown rather than pick one. */
  costProvider: string | null;
  createdAt: string;
}

export interface TaskBoardItem {
  id: string;
  organizationId: string;
  title: string;
  description: string | null;
  status: TaskBoardItemStatus;
  priority: TaskBoardItemPriority;
  assigneeId: string | null;
  assignedBy: string | null;
  /** `owner/name` of the repo (site) this task pertains to. Nullable: tasks
   *  created org-wide (no site context) carry none. */
  repo: string | null;
  dueDate: string | null;
  /** Manual drag-to-reorder position within a lane, ascending. */
  sortOrder: number;
  /** Per-org sequence behind the card's human key (`DECO-01`), never null. */
  keySeq: number;
  /** Infrastructure retries already spent on this card's runs — the budget
   *  `reactToFailedTaskRun` spends against `MAX_RUN_RETRIES`. */
  retryAttempts: number;
  /** Agent threads linked to this task (most-recent first). */
  threads: TaskBoardItemThreadRef[];
  /** Org tags attached to this task, name ascending. */
  tags: TaskBoardItemTagRef[];
  createdBy: string;
  createdAt: string;
  updatedBy: string;
  updatedAt: string;
}

/** What happened, for one entry in a task's change timeline. Derived from
 *  `TASK_BOARD_ACTIVITY_ACTIONS`, which the DB's CHECK constraint mirrors. */
export type { TaskBoardActivityAction };

/** Append-only: who did what to a task, and when. */
export interface TaskBoardActivityTable {
  id: string;
  task_board_item_id: string;
  action: TaskBoardActivityAction;
  /** The user who did it; null when the agent/system did, or when that user's
   *  account was deleted (FK `on delete set null`). */
  actor_id: string | null;
  data: ColumnType<
    Record<string, unknown> | null,
    string | null | undefined,
    string | null
  >;
  /** Updatable: a burst of prose edits coalesces onto one entry, moving it
   *  forward instead of appending a near-duplicate (`touchRecentActivity`). */
  occurred_at: ColumnType<Date, Date | string | undefined, Date | string>;
}

export interface TaskBoardActivity {
  id: string;
  taskBoardItemId: string;
  action: TaskBoardActivityAction;
  actorId: string | null;
  /** Event payload — e.g. { from, to } for a status/assignee change. */
  data: Record<string, unknown>;
  occurredAt: string;
}

// ============================================================================
// Brand Context Table Definition
// ============================================================================

export interface BrandContextTable {
  id: string;
  organization_id: string;
  name: string;
  domain: string;
  overview: string;
  logo: string | null;
  favicon: string | null;
  og_image: string | null;
  fonts: string | null;
  colors: string | null;
  images: string | null;
  metadata: string | null;
  archived_at: ColumnType<
    Date | null,
    Date | string | null,
    Date | string | null
  >;
  is_default: boolean;
  created_at: ColumnType<Date, Date | string, never>;
  updated_at: ColumnType<Date, Date | string, Date | string>;
}

export interface BrandContext {
  id: string;
  organizationId: string;
  name: string;
  domain: string;
  overview: string;
  logo: string | null;
  favicon: string | null;
  ogImage: string | null;
  fonts: {
    heading?: string;
    body?: string;
    code?: string;
  } | null;
  colors: {
    primary?: string;
    secondary?: string;
    accent?: string;
    background?: string;
    foreground?: string;
  } | null;
  images: Record<string, unknown>[] | null;
  metadata: Record<string, unknown> | null;
  archivedAt: Date | string | null;
  isDefault: boolean;
  createdAt: Date | string;
  updatedAt: Date | string;
}

/** Per-org Jira Cloud integration config (pull sync into the task board). */
export interface OrgJiraIntegrationTable {
  id: ColumnType<string, string | undefined, never>;
  organization_id: string;
  site_url: string;
  email: string;
  /** Vault-encrypted Jira API token (Basic auth pairs it with `email`). */
  api_token: string;
  /** Agile board the sync mirrors (its columns minus its Backlog tab). */
  board_id: string | null;
  board_name: string | null;
  /** { "<jira status name>": "<board status>" } — the per-tenant mapping.
   *  Issues whose Jira status is not a key here are skipped by the sync. */
  status_mapping: ColumnType<
    Record<string, TaskBoardItemStatus>,
    string | undefined,
    string
  >;
  /** Optional extra JQL ANDed into the pull (labels, sprints, …) — the
   *  tenant's way to match their board's saved filter. */
  jql_filter: ColumnType<
    string | null,
    string | null | undefined,
    string | null
  >;
  /** Issue lands in a To Do-mapped column → assign the Super Agent. */
  auto_delegate: ColumnType<boolean, boolean | undefined, boolean>;
  /** Capability URL segment for `/api/_jira/webhook/<secret>` — DB-generated,
   *  never updated. */
  webhook_secret: ColumnType<string, string | undefined, never>;
  enabled: ColumnType<boolean, boolean | undefined, boolean>;
  /** Incremental-sync watermark: the max issue `updated` fully processed —
   *  not "when the cron last ran". A truncated run advances it only as far
   *  as it got, so the next run resumes instead of skipping. */
  last_synced_at: ColumnType<Date | null, never, Date | string | null>;
  last_sync_error: ColumnType<string | null, never, string | null>;
  created_by: string;
  created_at: ColumnType<Date, Date | string | undefined, never>;
  updated_at: ColumnType<Date, Date | string | undefined, Date | string>;
}

export interface OrgJiraIntegration {
  id: string;
  organizationId: string;
  siteUrl: string;
  email: string;
  /** Decrypted — never include in tool outputs. */
  apiToken: string;
  boardId: string | null;
  boardName: string | null;
  statusMapping: Record<string, TaskBoardItemStatus>;
  jqlFilter: string | null;
  autoDelegate: boolean;
  webhookSecret: string;
  enabled: boolean;
  lastSyncedAt: string | null;
  lastSyncError: string | null;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

/** Board card ↔ Jira issue link. `jira_updated_at` is the issue's `updated`
 *  as of our last pull — an event or page with an older-or-equal `updated`
 *  is a no-op, which dedupes the sync's watermark overlap. */
export interface TaskBoardItemJiraLinkTable {
  item_id: string;
  organization_id: string;
  jira_issue_id: string;
  jira_issue_key: string;
  jira_updated_at: ColumnType<Date, Date | string, Date | string>;
  /** Last status name SEEN OR SET on the Jira side — the pull applies status
   *  only when this changed, and the status push records its target here so
   *  the resulting echo is a no-op. */
  jira_status: ColumnType<
    string | null,
    string | null | undefined,
    string | null
  >;
  created_at: ColumnType<Date, Date | string | undefined, never>;
}

/** Board comment ↔ Jira comment link — the echo/idempotency cut for comment
 *  sync: a Jira comment id with a link row is known (either we pushed it or
 *  already pulled it), never re-imported. */
export interface TaskBoardCommentJiraLinkTable {
  comment_id: string;
  organization_id: string;
  jira_comment_id: string;
  created_at: ColumnType<Date, Date | string | undefined, never>;
}

/**
 * Complete database schema
 * All tables exist within the organization scope (database boundary)
 *
 * NOTE: This uses *Table types with ColumnType for proper Kysely type mapping
 * NOTE: Organizations, teams, members, and roles are managed by Better Auth organization plugin
 */
export interface Database extends PrivateRegistryDatabase {
  // Core tables (all within organization scope)
  users: UserTable; // System users
  user: BetterAuthUserTable; // Better Auth core table (singular)
  connections: MCPConnectionTable; // MCP connections (organization-scoped)
  organization_settings: OrganizationSettingsTable; // Organization-level configuration
  user_model_preferences: UserModelPreferencesTable; // Per-user chat tier → model overrides
  api_keys: ApiKeyTable; // Better Auth API keys

  // OAuth tables (for MCP OAuth server)
  oauth_clients: OAuthClientTable;
  oauth_authorization_codes: OAuthAuthorizationCodeTable;
  oauth_refresh_tokens: OAuthRefreshTokenTable;
  downstream_tokens: DownstreamTokenTable;
  connection_workload_tokens: ConnectionWorkloadTokenTable;
  connection_credential_grants: ConnectionCredentialGrantTable;

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
  thread_message_parts: ThreadMessagePartTable;
  async_research_jobs: AsyncResearchJobTable;

  // Member tags tables
  organization_tags: OrganizationTagTable;
  member_tags: MemberTagTable;

  // Per-seat billing (dormant behind STUDIO_BILLING_ENFORCED)
  organization_billing: OrganizationBillingTable;
  task_quota_claims: TaskQuotaClaimTable;
  subsidized_gateway_keys: SubsidizedGatewayKeyTable;

  // Virtual MCP plugin configs
  virtual_mcp_plugin_configs: VirtualMcpPluginConfigTable;

  // AI Provider keys tables
  ai_provider_keys: AIProviderKeyTable;

  // Generic secrets vault (org and user scoped)
  secrets: SecretTable;

  // Org-scoped S3 bucket configurations
  org_file_configs: OrgFileConfigTable;

  // Org filesystem manifest (indexes the `_fs/{volume}/...` keyspace)
  org_fs_entry: OrgFsEntryTable;

  // OAuth PKCE state table (short-lived, server-side verifier storage)
  oauth_pkce_states: OAuthPkceStateTable;
  claude_subscriptions: ClaudeSubscriptionTable;

  // Automations tables
  automations: AutomationTable;
  automation_triggers: AutomationTriggerTable;

  // Trigger callback tokens (for external MCP → Studio callbacks)
  trigger_callback_tokens: TriggerCallbackTokenTable;

  // Organization SSO tables
  org_sso_config: OrgSsoConfigTable;
  org_sso_sessions: OrgSsoSessionTable;

  // Generic org-scoped KV store
  kv: KVTable;

  // Brand context (org-scoped company profile)
  brand_context: BrandContextTable;

  // Organization domain claims (for auto-join / request-to-join)
  organization_domains: OrganizationDomainTable;

  // Pending/decided requests to join an org
  organization_join_requests: OrganizationJoinRequestTable;

  // Asset tenancy: org ownership of globally-unique site slugs
  org_sites: OrgSiteTable;
  org_repo_sync: OrgRepoSyncTable;
  task_board_items: TaskBoardItemTable;
  task_board_item_threads: TaskBoardItemThreadTable;
  task_board_activity: TaskBoardActivityTable;
  task_board_item_prs: TaskBoardItemPrTable;
  task_board_review_claims: TaskBoardReviewClaimTable;
  task_board_comments: TaskBoardCommentTable;
  task_board_item_tags: TaskBoardItemTagTable;
  task_board_import_runs: TaskBoardImportRunTable;

  // Jira integration (per-org pull sync into the task board)
  org_jira_integrations: OrgJiraIntegrationTable;
  task_board_item_jira_links: TaskBoardItemJiraLinkTable;
  task_board_comment_jira_links: TaskBoardCommentJiraLinkTable;

  sandbox_runner_state: SandboxProviderStateTable;
}
