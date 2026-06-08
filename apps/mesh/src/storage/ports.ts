/**
 * Storage Port Interfaces
 *
 * These interfaces define the contracts for storage adapters.
 * Following the Ports & Adapters (Hexagonal Architecture) pattern.
 */

import type {
  OrderByExpression,
  WhereExpression,
} from "@decocms/bindings/collections";
import type { ConnectionEntity } from "../tools/connection/schema";
import type {
  VirtualMCPEntity,
  VirtualMCPCreateData,
  VirtualMCPUpdateData,
} from "../tools/virtual/schema";
import type {
  AsyncResearchJob,
  AsyncResearchJobCitation,
  BrandContext,
  MonitoringLog,
  OrganizationDomain,
  OrganizationSettings,
  OrganizationTag,
  Thread,
  ThreadMessage,
} from "./types";

export interface ThreadStoragePort {
  create(data: Partial<Thread>): Promise<Thread>;
  get(id: string, organizationId: string): Promise<Thread | null>;
  update(
    id: string,
    organizationId: string,
    data: Partial<Thread>,
  ): Promise<Thread>;
  /**
   * Atomically transitions a thread to "failed" only when its current
   * persisted status is "in_progress". Safe to call concurrently — the
   * conditional WHERE clause prevents clobbering a terminal status.
   *
   * Returns true if the row was updated, false if it was already in a
   * terminal state (no-op).
   */
  forceFailIfInProgress(id: string, organizationId: string): Promise<boolean>;
  delete(id: string, organizationId: string): Promise<void>;
  list(
    organizationId: string,
    createdBy?: string,
    options?: {
      limit?: number;
      offset?: number;
      virtualMcpId?: string;
      startDate?: string;
      endDate?: string;
      search?: string;
      status?: string;
      agentId?: string;
      includeArchived?: boolean;
      hasTrigger?: boolean;
    },
  ): Promise<{ threads: Thread[]; total: number }>;
  listByTriggerIds(
    organizationId: string,
    triggerIds: string[],
    options?: { limit?: number; offset?: number },
  ): Promise<{ threads: Thread[]; total: number }>;
  /** Atomically claim an orphaned run. Returns true if this pod won the CAS. */
  claimOrphanedRun(
    taskId: string,
    organizationId: string,
    podId: string,
  ): Promise<boolean>;

  /** List all in_progress threads not owned by the given pod (null or stale owner). */
  listOrphanedRuns(currentPodId: string): Promise<Thread[]>;

  /** List all in_progress threads owned by a specific (dead) pod. */
  listOrphanedRunsByPod(deadPodId: string): Promise<Thread[]>;

  /**
   * Atomically claim a run start via CAS. Returns true if this pod won.
   * Allows: new runs (not in_progress), orphans (null pod), or same-pod restarts.
   */
  claimRunStart(
    taskId: string,
    organizationId: string,
    data: Partial<Thread>,
    podId: string | null,
  ): Promise<boolean>;

  /** Release ownership for all runs owned by this pod (graceful shutdown). */
  orphanRunsByPod(podId: string): Promise<string[]>;

  /**
   * Stamp `last_progress_at = now()` on a thread. Cheap single-column UPDATE
   * used by the progress-liveness heartbeat (throttled by the caller). No-op
   * if the row doesn't exist.
   */
  bumpProgress(taskId: string, organizationId: string): Promise<void>;

  /**
   * Read the progress-liveness columns for a thread. `lastProgressAt` is the
   * epoch-ms of the most recent progress signal (null when the run just
   * started and hasn't emitted a chunk yet); `runStartedAt` is the epoch-ms
   * the current run claimed the thread (null when not running). The reaper
   * uses these to decide whether a run is stuck (`isRunStuck`).
   */
  getProgress(
    taskId: string,
    organizationId: string,
  ): Promise<{
    lastProgressAt: number | null;
    runStartedAt: number | null;
  } | null>;

  /**
   * For each given virtual MCP id, return the timestamp and creator of the most recent thread.
   * Used by the dedicated last-used endpoint; not on the agent fetch hot path.
   */
  findLastUsedByVirtualMcpIds(
    organizationId: string,
    virtualMcpIds: string[],
  ): Promise<Map<string, { last_used_at: string; last_used_by: string }>>;

  // Message operations - upserts by id (updates existing rows)
  saveMessages(data: ThreadMessage[], organizationId: string): Promise<void>;
  listMessages(
    taskId: string,
    organizationId: string,
    options?: {
      limit?: number;
      offset?: number;
      sort?: "asc" | "desc";
    },
  ): Promise<{ messages: ThreadMessage[]; total: number }>;
}

// ============================================================================
// Async Research Jobs Storage Port
// ============================================================================

/**
 * Persistent store for async research jobs (Gemini Deep Research et al).
 *
 * Each `web_search` tool call that goes through a submit-then-poll provider
 * gets one row here. The row is the source of truth for the job's lifecycle:
 * the runtime reads it on resume, writes status transitions as the job
 * progresses, and never deletes rows so the table doubles as an audit log.
 *
 * Idempotency on (organizationId, toolCallId) — DBOS replay of the tool
 * step MUST find the existing row instead of submitting a duplicate
 * provider job.
 */
export interface AsyncResearchJobStoragePort {
  /**
   * Insert a new row in status='pending'. Returns the existing row if one
   * already exists for (organizationId, toolCallId) — that's the resume
   * path on DBOS step replay or pod handoff.
   */
  upsertPending(input: {
    organizationId: string;
    threadId: string;
    toolCallId: string;
    messageId?: string | null;
    provider: string;
    modelId: string;
    query: string;
  }): Promise<AsyncResearchJob>;

  findByToolCall(
    organizationId: string,
    toolCallId: string,
  ): Promise<AsyncResearchJob | null>;

  /**
   * Transition pending → polling once the provider has accepted the job
   * and returned an interaction id. The interaction id is the only key
   * Studio operators have for cross-referencing logs with the upstream
   * provider's console.
   *
   * Atomically writes a stub `thread_messages` row that carries the
   * `tool-input-available` part. Without that stub, a browser refresh
   * during the long polling window leaves `loadInitialPage` with no
   * assistant message to seed the AI SDK reader, and the eventual
   * `tool-output-available` chunk on reconnect throws "No tool
   * invocation found for tool call ID …" (ai/dist/index.mjs:5398).
   *
   * The stub uses the deterministic id `msg_async_stub_<toolCallId>`
   * and is deleted by `markCompleted` / `markFailed` / `markCancelled`
   * in the same transaction as the status flip — so callers never
   * observe a half-state of "polling row exists but no stub" or vice
   * versa.
   */
  markPolling(
    organizationId: string,
    toolCallId: string,
    interactionId: string,
    stub: {
      threadId: string;
      toolName: string;
      query: string;
    },
  ): Promise<void>;

  /** Bump `attempts` and refresh `last_polled_at`. Cheap UPDATE per tick. */
  recordPoll(
    organizationId: string,
    toolCallId: string,
    lastError?: string | null,
  ): Promise<void>;

  markCompleted(
    organizationId: string,
    toolCallId: string,
    result: {
      inputTokens: number;
      outputTokens: number;
      citations: AsyncResearchJobCitation[];
      /**
       * Blob-storage URI when the report was offloaded for size, NULL
       * for inline results. When set, `resultContent` is NULL and the
       * full text is fetched from blob storage on read.
       */
      resultUri: string | null;
      /** Short truncated snippet for SQL-side inspection. */
      resultPreview: string;
      /**
       * Full report text for inline results; NULL when offloaded to
       * blob. Used by replays of the same tool_call_id so a re-entry
       * returns the original content rather than just the preview.
       */
      resultContent: string | null;
    },
  ): Promise<void>;

  markFailed(
    organizationId: string,
    toolCallId: string,
    error: string,
  ): Promise<void>;

  markCancelled(
    organizationId: string,
    toolCallId: string,
    reason?: string,
  ): Promise<void>;

  /**
   * Flip any row in pending/polling that hasn't been touched within
   * `staleAfterMs` to status='abandoned'. Returns the number of rows
   * affected so the caller can log when it actually does something.
   */
  sweepAbandoned(staleAfterMs: number): Promise<number>;
}

// ============================================================================
// Connection Storage Port
// ============================================================================

export interface ConnectionStoragePort {
  create(data: Partial<ConnectionEntity>): Promise<ConnectionEntity>;
  findById(id: string): Promise<ConnectionEntity | null>;
  list(
    organizationId: string,
    options?: {
      includeVirtual?: boolean;
      slug?: string;
      where?: WhereExpression;
      orderBy?: OrderByExpression[];
      limit?: number;
      offset?: number;
    },
  ): Promise<{ items: ConnectionEntity[]; totalCount: number }>;
  update(
    id: string,
    data: Partial<ConnectionEntity>,
  ): Promise<ConnectionEntity>;
  delete(id: string): Promise<void>;
  testConnection(
    id: string,
    headers?: Record<string, string>,
  ): Promise<{ healthy: boolean; latencyMs: number }>;
}

// ============================================================================
// Organization Settings Storage Port
// ============================================================================

export interface OrganizationSettingsStoragePort {
  get(organizationId: string): Promise<OrganizationSettings | null>;
  upsert(
    organizationId: string,
    data?: Partial<
      Pick<
        OrganizationSettings,
        | "sidebar_items"
        | "enabled_plugins"
        | "registry_config"
        | "simple_mode"
        | "default_home_agents"
      >
    >,
  ): Promise<OrganizationSettings>;
}

// ============================================================================
// Monitoring Storage Interface
// ============================================================================

/**
 * Property filter options for querying monitoring logs
 */
export interface PropertyFilters {
  /** Exact match: filter logs where property key equals value */
  properties?: Record<string, string>;
  /** Exists: filter logs that have these property keys */
  propertyKeys?: string[];
  /** Pattern match: filter logs where property value matches pattern (SQL LIKE) */
  propertyPatterns?: Record<string, string>;
  /** In match: filter logs where property value (comma-separated) contains the specified value */
  propertyInValues?: Record<string, string>;
}

export type AggregationFunction =
  | "sum"
  | "avg"
  | "min"
  | "max"
  | "count"
  | "count_all"
  | "last";

export type GroupByColumn =
  | "connection_id"
  | "user_id"
  | "tool_name"
  | "virtual_mcp_id";

export interface AggregationParams {
  organizationId: string;
  path: string;
  from: "input" | "output";
  aggregation: AggregationFunction;
  groupBy?: string;
  groupByColumn?: GroupByColumn;
  interval?: string;
  limit?: number;
  filters?: {
    connectionIds?: string[];
    virtualMcpIds?: string[];
    toolNames?: string[];
    startDate?: Date;
    endDate?: Date;
    propertyFilters?: PropertyFilters;
  };
}

export interface AggregationResult {
  value: number | null;
  groups?: Array<{ key: string; value: number }>;
  timeseries?: Array<{ timestamp: string; value: number }>;
}

export interface MonitoringStorage {
  query(filters: {
    organizationId: string;
    connectionId?: string;
    excludeConnectionIds?: string[];
    virtualMcpId?: string;
    toolName?: string;
    isError?: boolean;
    startDate?: Date;
    endDate?: Date;
    limit?: number;
    offset?: number;
    propertyFilters?: PropertyFilters;
  }): Promise<{ logs: MonitoringLog[]; total: number }>;
  getById(organizationId: string, id: string): Promise<MonitoringLog | null>;
  getStats(filters: {
    organizationId: string;
    startDate?: Date;
    endDate?: Date;
  }): Promise<{
    totalCalls: number;
    errorRate: number;
    avgDurationMs: number;
  }>;
  aggregate(params: AggregationParams): Promise<AggregationResult>;
  countMatched(params: {
    organizationId: string;
    path: string;
    from: "input" | "output";
    filters?: {
      connectionIds?: string[];
      toolNames?: string[];
      virtualMcpIds?: string[];
      startDate?: Date;
      endDate?: Date;
      propertyFilters?: PropertyFilters;
    };
  }): Promise<number>;

  /** Query pre-aggregated OTel metrics for timeseries charts */
  queryMetricTimeseries(params: {
    organizationId: string;
    interval: string;
    startDate?: Date;
    endDate?: Date;
    filters?: {
      connectionIds?: string[];
      excludeConnectionIds?: string[];
      toolNames?: string[];
      status?: "success" | "error";
    };
  }): Promise<{
    totalCalls: number;
    totalErrors: number;
    avgDurationMs: number;
    p50DurationMs: number;
    p95DurationMs: number;
    connectionBreakdown: Array<{
      connectionId: string;
      calls: number;
      errors: number;
      errorRate: number;
      avgDurationMs: number;
    }>;
    timeseries: Array<{
      timestamp: string;
      calls: number;
      errors: number;
      errorRate: number;
      avg: number;
      p50: number;
      p95: number;
    }>;
  }>;
  queryMetricTopToolsTimeseries(params: {
    organizationId: string;
    interval: string;
    startDate?: Date;
    endDate?: Date;
    topN?: number;
    filters?: {
      connectionIds?: string[];
      excludeConnectionIds?: string[];
      toolNames?: string[];
      status?: "success" | "error";
    };
  }): Promise<{
    topTools: Array<{
      toolName: string;
      connectionId: string | null;
      calls: number;
    }>;
    timeseries: Array<{
      timestamp: string;
      toolName: string;
      calls: number;
      errors: number;
      avg: number;
      p95: number;
    }>;
  }>;
}

// ============================================================================
// Virtual MCP Storage Port
// ============================================================================

// Re-export types from schema for convenience
export type {
  VirtualMCPEntity,
  VirtualMCPCreateData,
  VirtualMCPUpdateData,
} from "../tools/virtual/schema";

export interface VirtualMCPStoragePort {
  create(
    organizationId: string,
    userId: string,
    data: VirtualMCPCreateData,
    options?: { id?: string },
  ): Promise<VirtualMCPEntity>;
  findById(
    id: string,
    organizationId?: string,
  ): Promise<VirtualMCPEntity | null>;
  list(
    organizationId: string,
    options?: { pinnedOnly?: boolean },
  ): Promise<VirtualMCPEntity[]>;
  listByIds(organizationId: string, ids: string[]): Promise<VirtualMCPEntity[]>;
  listByConnectionId(
    organizationId: string,
    connectionId: string,
  ): Promise<VirtualMCPEntity[]>;
  update(
    id: string,
    userId: string,
    data: VirtualMCPUpdateData,
  ): Promise<VirtualMCPEntity>;
  delete(id: string): Promise<void>;
  removeConnectionReferences(connectionId: string): Promise<void>;
}

// ============================================================================
// Virtual MCP Plugin Config Storage Port
// ============================================================================

export interface VirtualMcpPluginConfig {
  id: string;
  virtualMcpId: string;
  pluginId: string;
  connectionId: string | null;
  settings: Record<string, unknown> | null;
  createdAt: Date | string;
  updatedAt: Date | string;
}

export interface BoundConnectionSummary {
  id: string;
  title: string;
  icon: string | null;
}

export interface VirtualMcpPluginConfigStoragePort {
  list(virtualMcpId: string): Promise<VirtualMcpPluginConfig[]>;
  get(
    virtualMcpId: string,
    pluginId: string,
  ): Promise<VirtualMcpPluginConfig | null>;
  upsert(
    virtualMcpId: string,
    pluginId: string,
    data: {
      connectionId?: string | null;
      settings?: Record<string, unknown> | null;
    },
  ): Promise<VirtualMcpPluginConfig>;
  delete(virtualMcpId: string, pluginId: string): Promise<boolean>;
  getBoundConnectionsForVirtualMcps(
    virtualMcpIds: string[],
  ): Promise<Map<string, BoundConnectionSummary[]>>;
}

// ============================================================================
// Tag Storage Port
// ============================================================================

export interface TagStoragePort {
  // Organization tags
  listOrgTags(organizationId: string): Promise<OrganizationTag[]>;
  getTag(tagId: string): Promise<OrganizationTag | null>;
  getTagByName(
    organizationId: string,
    name: string,
  ): Promise<OrganizationTag | null>;
  createTag(organizationId: string, name: string): Promise<OrganizationTag>;
  deleteTag(tagId: string): Promise<void>;

  // Member tags
  getMemberTags(memberId: string): Promise<OrganizationTag[]>;
  setMemberTags(memberId: string, tagIds: string[]): Promise<void>;
  addMemberTag(memberId: string, tagId: string): Promise<void>;
  removeMemberTag(memberId: string, tagId: string): Promise<void>;

  // Member verification
  verifyMemberOrg(memberId: string, organizationId: string): Promise<boolean>;

  // Bulk operations for monitoring
  getUserTagsInOrg(
    userId: string,
    organizationId: string,
  ): Promise<OrganizationTag[]>;
  getMembersWithTags(organizationId: string): Promise<Map<string, string[]>>;
}

// ============================================================================
// Brand Context Storage Port
// ============================================================================

// ============================================================================
// Organization Domain Storage Port
// ============================================================================

export interface OrganizationDomainStoragePort {
  getAllByDomain(domain: string): Promise<OrganizationDomain[]>;
  getByOrganizationId(
    organizationId: string,
  ): Promise<OrganizationDomain | null>;
  setDomain(
    organizationId: string,
    domain: string,
    autoJoinEnabled?: boolean,
  ): Promise<OrganizationDomain>;
  updateAutoJoin(
    organizationId: string,
    autoJoinEnabled: boolean,
  ): Promise<OrganizationDomain>;
  clearDomain(organizationId: string): Promise<void>;
}

export interface BrandContextStoragePort {
  get(id: string, organizationId: string): Promise<BrandContext | null>;
  list(
    organizationId: string,
    options?: { includeArchived?: boolean },
  ): Promise<BrandContext[]>;
  getDefault(organizationId: string): Promise<BrandContext | null>;
  setDefault(id: string, organizationId: string): Promise<BrandContext>;
  create(
    organizationId: string,
    data: Omit<
      BrandContext,
      | "id"
      | "organizationId"
      | "archivedAt"
      | "isDefault"
      | "createdAt"
      | "updatedAt"
    >,
  ): Promise<BrandContext>;
  update(
    id: string,
    organizationId: string,
    data: Partial<
      Omit<BrandContext, "id" | "organizationId" | "createdAt" | "updatedAt">
    >,
  ): Promise<BrandContext>;
  delete(id: string, organizationId: string): Promise<void>;
}
