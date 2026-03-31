import type { ColumnType } from "kysely";

export interface PrivateRegistryItemTable {
  id: string;
  organization_id: string;
  title: string;
  description: ColumnType<string | null, string | null, string | null>;
  server_json: string;
  meta_json: ColumnType<string | null, string | null, string | null>;
  tags: ColumnType<string | null, string | null, string | null>;
  categories: ColumnType<string | null, string | null, string | null>;
  is_public: ColumnType<number, number, number>;
  is_unlisted: ColumnType<number, number, number>;
  created_at: ColumnType<string, string, string>;
  updated_at: ColumnType<string, string, string>;
  created_by: ColumnType<string | null, string | null, string | null>;
}

export type PublishRequestStatus = "pending" | "approved" | "rejected";
export type MonitorRunStatus =
  | "pending"
  | "running"
  | "completed"
  | "failed"
  | "cancelled";
export type MonitorResultStatus =
  | "passed"
  | "failed"
  | "skipped"
  | "error"
  | "needs_auth";
export type MonitorConnectionAuthStatus =
  | "none"
  | "needs_auth"
  | "authenticated";

export interface PublishRequestTable {
  id: string;
  organization_id: string;
  requested_id: ColumnType<string | null, string | null, string | null>;
  status: PublishRequestStatus;
  title: string;
  description: ColumnType<string | null, string | null, string | null>;
  server_json: string;
  meta_json: ColumnType<string | null, string | null, string | null>;
  requester_name: ColumnType<string | null, string | null, string | null>;
  requester_email: ColumnType<string | null, string | null, string | null>;
  reviewer_notes: ColumnType<string | null, string | null, string | null>;
  created_at: ColumnType<string, string, string>;
  updated_at: ColumnType<string, string, string>;
}

export interface PublishApiKeyTable {
  id: string;
  organization_id: string;
  name: string;
  key_hash: string;
  prefix: string;
  created_at: ColumnType<string, string, string>;
}

export interface MonitorRunTable {
  id: string;
  organization_id: string;
  status: MonitorRunStatus;
  config_snapshot: ColumnType<string | null, string | null, string | null>;
  total_items: ColumnType<number, number, number>;
  tested_items: ColumnType<number, number, number>;
  passed_items: ColumnType<number, number, number>;
  failed_items: ColumnType<number, number, number>;
  skipped_items: ColumnType<number, number, number>;
  current_item_id: ColumnType<string | null, string | null, string | null>;
  started_at: ColumnType<string | null, string | null, string | null>;
  finished_at: ColumnType<string | null, string | null, string | null>;
  created_at: ColumnType<string, string, string>;
}

export interface MonitorResultTable {
  id: string;
  run_id: string;
  organization_id: string;
  item_id: string;
  item_title: string;
  status: MonitorResultStatus;
  error_message: ColumnType<string | null, string | null, string | null>;
  connection_ok: ColumnType<number, number, number>;
  tools_listed: ColumnType<number, number, number>;
  tool_results: ColumnType<string | null, string | null, string | null>;
  agent_summary: ColumnType<string | null, string | null, string | null>;
  duration_ms: ColumnType<number, number, number>;
  action_taken: string;
  tested_at: ColumnType<string, string, string>;
}

export interface MonitorConnectionTable {
  id: string;
  organization_id: string;
  item_id: string;
  connection_id: string;
  auth_status: MonitorConnectionAuthStatus;
  created_at: ColumnType<string, string, string>;
  updated_at: ColumnType<string, string, string>;
}

export interface PrivateRegistryDatabase {
  private_registry_item: PrivateRegistryItemTable;
  private_registry_publish_request: PublishRequestTable;
  private_registry_publish_api_key: PublishApiKeyTable;
  private_registry_monitor_run: MonitorRunTable;
  private_registry_monitor_result: MonitorResultTable;
  private_registry_monitor_connection: MonitorConnectionTable;
}

export interface RegistryToolMeta {
  name: string;
  description?: string | null;
}

export interface MeshRegistryMeta {
  verified?: boolean;
  official?: boolean;
  tags?: string[];
  categories?: string[];
  friendly_name?: string | null;
  short_description?: string | null;
  owner?: string | null;
  readme?: string | null;
  readme_url?: string | null;
  has_remote?: boolean;
  has_oauth?: boolean;
  tools?: RegistryToolMeta[];
  [key: string]: unknown;
}

export interface RegistryItemMeta {
  "mcp.mesh"?: MeshRegistryMeta;
  [key: string]: unknown;
}

export interface RegistryRemote {
  type?: string;
  url?: string;
  name?: string;
  title?: string;
  description?: string;
}

export interface RegistryPackage {
  identifier: string;
  version?: string;
  [key: string]: unknown;
}

export interface RegistryServerDefinition {
  $schema?: string;
  name: string;
  title?: string;
  description?: string;
  version?: string;
  websiteUrl?: string;
  icons?: Array<{ src: string }>;
  remotes?: RegistryRemote[];
  packages?: RegistryPackage[];
  repository?: {
    url?: string;
    source?: string;
    subfolder?: string;
  };
  [key: string]: unknown;
}

export interface PrivateRegistryItemEntity {
  id: string;
  name?: string;
  title: string;
  description: string | null;
  _meta?: RegistryItemMeta;
  server: RegistryServerDefinition;
  is_public: boolean;
  is_unlisted: boolean;
  created_at: string;
  updated_at: string;
  created_by?: string;
}

export interface PrivateRegistryCreateInput {
  organization_id: string;
  id: string;
  title: string;
  description?: string | null;
  _meta?: RegistryItemMeta;
  server: RegistryServerDefinition;
  is_public?: boolean;
  is_unlisted?: boolean;
  created_by?: string | null;
}

export interface PrivateRegistryUpdateInput {
  title?: string;
  description?: string | null;
  _meta?: RegistryItemMeta;
  server?: RegistryServerDefinition;
  is_public?: boolean;
  is_unlisted?: boolean;
}

export interface RegistryWhereExpression {
  field?: string[];
  operator?:
    | "eq"
    | "gt"
    | "gte"
    | "lt"
    | "lte"
    | "in"
    | "like"
    | "contains"
    | "and"
    | "or"
    | "not";
  value?: unknown;
  conditions?: RegistryWhereExpression[];
}

export interface PrivateRegistryListQuery {
  limit?: number;
  offset?: number;
  cursor?: string;
  tags?: string[];
  categories?: string[];
  where?: RegistryWhereExpression;
  includeUnlisted?: boolean;
}

export interface PrivateRegistryListResult {
  items: PrivateRegistryItemEntity[];
  totalCount: number;
  hasMore: boolean;
  nextCursor?: string;
}

/** Slim projection returned by the search tool to save tokens. */
export interface PrivateRegistrySearchItem {
  id: string;
  title: string;
  tags: string[];
  categories: string[];
  is_public: boolean;
  is_unlisted: boolean;
}

export interface PrivateRegistrySearchQuery {
  query?: string;
  tags?: string[];
  categories?: string[];
  limit?: number;
  cursor?: string;
}

export interface PrivateRegistrySearchResult {
  items: PrivateRegistrySearchItem[];
  totalCount: number;
  hasMore: boolean;
  nextCursor?: string;
}

export interface PublishRequestEntity {
  id: string;
  organization_id: string;
  requested_id: string | null;
  status: PublishRequestStatus;
  title: string;
  description: string | null;
  _meta?: RegistryItemMeta;
  server: RegistryServerDefinition;
  requester_name: string | null;
  requester_email: string | null;
  reviewer_notes: string | null;
  created_at: string;
  updated_at: string;
}

export interface PublishRequestCreateInput {
  organization_id: string;
  requested_id: string;
  title: string;
  description?: string | null;
  _meta?: RegistryItemMeta;
  server: RegistryServerDefinition;
  requester_name?: string | null;
  requester_email?: string | null;
}

export interface PublishApiKeyEntity {
  id: string;
  organization_id: string;
  name: string;
  prefix: string;
  created_at: string;
}

export interface MonitorToolResult {
  toolName: string;
  success: boolean;
  durationMs: number;
  input?: Record<string, unknown>;
  outputPreview?: string | null;
  error?: string | null;
}

export interface MonitorRunConfigSnapshot {
  monitorMode: "health_check" | "tool_call" | "full_agent";
  onFailure:
    | "none"
    | "unlisted"
    | "remove_public"
    | "remove_private"
    | "remove_all";
  perMcpTimeoutMs?: number;
  perToolTimeoutMs?: number;
  maxAgentSteps?: number;
  agentContext?: string;
  llmConnectionId?: string;
  llmModelId?: string;
  testPublicOnly?: boolean;
  testPrivateOnly?: boolean;
  includePendingRequests?: boolean;
  schedule?: "manual" | "cron";
  cronExpression?: string;
  scheduleEventId?: string;
}

export interface MonitorRunEntity {
  id: string;
  organization_id: string;
  status: MonitorRunStatus;
  config_snapshot: MonitorRunConfigSnapshot | null;
  total_items: number;
  tested_items: number;
  passed_items: number;
  failed_items: number;
  skipped_items: number;
  current_item_id: string | null;
  started_at: string | null;
  finished_at: string | null;
  created_at: string;
}

export interface MonitorResultEntity {
  id: string;
  run_id: string;
  organization_id: string;
  item_id: string;
  item_title: string;
  status: MonitorResultStatus;
  error_message: string | null;
  connection_ok: boolean;
  tools_listed: boolean;
  tool_results: MonitorToolResult[];
  agent_summary: string | null;
  duration_ms: number;
  action_taken: string;
  tested_at: string;
}

export interface MonitorConnectionEntity {
  id: string;
  organization_id: string;
  item_id: string;
  connection_id: string;
  auth_status: MonitorConnectionAuthStatus;
  created_at: string;
  updated_at: string;
}
