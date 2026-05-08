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
  BrandContext,
  InflightAsyncJob,
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

  /** Append an entry to threads.inflight_async_jobs. Atomic via jsonb concat. */
  addInflightAsyncJob(
    taskId: string,
    organizationId: string,
    entry: InflightAsyncJob,
  ): Promise<void>;

  /**
   * Find an in-flight async job for this thread matching provider + modelId + query.
   * Returns the most recently submitted match, or null.
   */
  findInflightAsyncJob(
    taskId: string,
    organizationId: string,
    provider: string,
    modelId: string,
    query: string,
  ): Promise<InflightAsyncJob | null>;

  /** Remove all entries matching provider + modelId + query from threads.inflight_async_jobs. */
  removeInflightAsyncJob(
    taskId: string,
    organizationId: string,
    provider: string,
    modelId: string,
    query: string,
  ): Promise<void>;

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
  getByDomain(domain: string): Promise<OrganizationDomain | null>;
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
