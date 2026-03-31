export interface RegistryRemote {
  type?: string;
  url?: string;
  name?: string;
  title?: string;
  description?: string;
}

export interface RegistryServerDefinition {
  name: string;
  title?: string;
  description?: string;
  version?: string;
  websiteUrl?: string;
  icons?: Array<{ src: string }>;
  remotes?: RegistryRemote[];
  repository?: {
    url?: string;
    source?: string;
    subfolder?: string;
  };
  [key: string]: unknown;
}

export interface RegistryToolMeta {
  name: string;
  description?: string | null;
}

export interface RegistryMeshMeta {
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

export interface RegistryItem {
  id: string;
  name?: string;
  title: string;
  description?: string | null;
  _meta?: {
    "mcp.mesh"?: RegistryMeshMeta;
    [key: string]: unknown;
  };
  server: RegistryServerDefinition;
  is_public?: boolean;
  is_unlisted?: boolean;
  created_at?: string;
  updated_at?: string;
  created_by?: string;
}

export interface RegistryFilters {
  tags: Array<{ value: string; count: number }>;
  categories: Array<{ value: string; count: number }>;
}

export interface RegistryListResponse {
  items: RegistryItem[];
  totalCount: number;
  hasMore?: boolean;
  nextCursor?: string;
}

export interface RegistryCreateInput {
  id: string;
  title: string;
  description?: string | null;
  _meta?: RegistryItem["_meta"];
  server: RegistryServerDefinition;
  is_public?: boolean;
  is_unlisted?: boolean;
}

export interface RegistryUpdateInput {
  title?: string;
  description?: string | null;
  _meta?: RegistryItem["_meta"];
  server?: RegistryServerDefinition;
  is_public?: boolean;
  is_unlisted?: boolean;
}

export interface RegistryBulkCreateResult {
  created: number;
  errors: Array<{ id: string; error: string }>;
}

export type PublishRequestStatus = "pending" | "approved" | "rejected";

export interface PublishRequest {
  id: string;
  organization_id: string;
  requested_id?: string | null;
  status: PublishRequestStatus;
  title: string;
  description?: string | null;
  _meta?: RegistryItem["_meta"];
  server: RegistryServerDefinition;
  requester_name?: string | null;
  requester_email?: string | null;
  reviewer_notes?: string | null;
  created_at: string;
  updated_at: string;
}

export interface PublishRequestListResponse {
  items: PublishRequest[];
  totalCount: number;
}

export interface PublishApiKey {
  id: string;
  name: string;
  prefix: string;
  createdAt: string;
}

export interface PublishApiKeyGenerateResult {
  id: string;
  name: string;
  prefix: string;
  key: string;
  createdAt: string;
}

export interface PublishApiKeyListResponse {
  items: PublishApiKey[];
}

export type MonitorMode = "health_check" | "tool_call" | "full_agent";
export type MonitorFailureAction =
  | "none"
  | "unlisted"
  | "remove_public"
  | "remove_private"
  | "remove_all";
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

export interface RegistryMonitorConfig {
  monitorMode: MonitorMode;
  onFailure: MonitorFailureAction;
  schedule?: "manual" | "cron";
  cronExpression?: string;
  scheduleEventId?: string;
  perMcpTimeoutMs: number;
  perToolTimeoutMs: number;
  maxAgentSteps: number;
  testPublicOnly: boolean;
  testPrivateOnly: boolean;
  includePendingRequests: boolean;
  agentContext?: string;
  llmConnectionId?: string;
  llmModelId?: string;
}

export interface MonitorToolResult {
  toolName: string;
  success: boolean;
  durationMs: number;
  input?: Record<string, unknown>;
  outputPreview?: string | null;
  error?: string | null;
}

export interface MonitorRun {
  id: string;
  organization_id: string;
  status: MonitorRunStatus;
  config_snapshot: RegistryMonitorConfig | null;
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

export interface MonitorResult {
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

export interface MonitorRunListResponse {
  items: MonitorRun[];
  totalCount: number;
}

export interface MonitorResultListResponse {
  items: MonitorResult[];
  totalCount: number;
}

export interface MonitorConnectionMapping {
  id: string;
  organization_id: string;
  item_id: string;
  connection_id: string;
  auth_status: MonitorConnectionAuthStatus;
  created_at: string;
  updated_at: string;
}

export interface MonitorConnectionListItem {
  mapping: MonitorConnectionMapping;
  item: RegistryItem | null;
  remoteUrl: string | null;
  source: "store" | "request";
}

export interface MonitorConnectionListResponse {
  items: MonitorConnectionListItem[];
}
