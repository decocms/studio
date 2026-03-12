/**
 * Storage Port Interfaces
 *
 * These interfaces define the contracts for storage adapters.
 * Following the Ports & Adapters (Hexagonal Architecture) pattern.
 */

import type { ConnectionEntity } from "../tools/connection/schema";
import type {
  VirtualMCPEntity,
  VirtualMCPCreateData,
  VirtualMCPUpdateData,
} from "../tools/virtual/schema";
import type {
  MonitoringLog,
  OrganizationSettings,
  OrganizationTag,
  Project,
  ProjectConnection,
  ProjectPluginConfig,
  ProjectUI,
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
    options?: { limit?: number; offset?: number },
  ): Promise<{ threads: Thread[]; total: number }>;
  listByTriggerIds(
    organizationId: string,
    triggerIds: string[],
    options?: { limit?: number; offset?: number },
  ): Promise<{ threads: Thread[]; total: number }>;
  // Message operations - upserts by id (updates existing rows)
  saveMessages(data: ThreadMessage[], organizationId: string): Promise<void>;
  listMessages(
    threadId: string,
    organizationId: string,
    options?: {
      limit?: number;
      offset?: number;
      sort?: "asc" | "desc";
    },
  ): Promise<{ messages: ThreadMessage[]; total: number }>;
}

// ============================================================================
// Project Storage Ports
// ============================================================================

export interface ProjectStoragePort {
  list(organizationId: string): Promise<Project[]>;
  get(projectId: string): Promise<Project | null>;
  getBySlug(organizationId: string, slug: string): Promise<Project | null>;
  create(data: {
    organizationId: string;
    slug: string;
    name: string;
    description?: string | null;
    enabledPlugins?: string[] | null;
    ui?: ProjectUI | null;
  }): Promise<Project>;
  update(
    projectId: string,
    data: Partial<{
      name: string;
      description: string | null;
      enabledPlugins: string[] | null;
      ui: ProjectUI | null;
    }>,
  ): Promise<Project | null>;
  delete(projectId: string): Promise<boolean>;
}

export interface ProjectConnectionStoragePort {
  list(projectId: string): Promise<ProjectConnection[]>;
  add(projectId: string, connectionId: string): Promise<ProjectConnection>;
  remove(projectId: string, connectionId: string): Promise<boolean>;
}

export interface ProjectPluginConfigStoragePort {
  list(projectId: string): Promise<ProjectPluginConfig[]>;
  get(projectId: string, pluginId: string): Promise<ProjectPluginConfig | null>;
  upsert(
    projectId: string,
    pluginId: string,
    data: {
      connectionId?: string | null;
      settings?: Record<string, unknown> | null;
    },
  ): Promise<ProjectPluginConfig>;
  delete(projectId: string, pluginId: string): Promise<boolean>;
  listByConnectionId(connectionId: string): Promise<ProjectPluginConfig[]>;
}

// ============================================================================
// Connection Storage Port
// ============================================================================

export interface ConnectionStoragePort {
  create(data: Partial<ConnectionEntity>): Promise<ConnectionEntity>;
  findById(id: string): Promise<ConnectionEntity | null>;
  list(
    organizationId: string,
    options?: { includeVirtual?: boolean },
  ): Promise<ConnectionEntity[]>;
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
      Pick<OrganizationSettings, "sidebar_items" | "enabled_plugins">
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
  | "connection_title"
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

import type {
  VirtualToolEntity,
  VirtualToolCreateData,
  VirtualToolUpdateData,
} from "../tools/virtual-tool/schema";

// Re-export virtual tool types
export type { VirtualToolEntity, VirtualToolCreateData, VirtualToolUpdateData };

export interface VirtualMCPStoragePort {
  create(
    organizationId: string,
    userId: string,
    data: VirtualMCPCreateData,
  ): Promise<VirtualMCPEntity>;
  findById(
    id: string,
    organizationId?: string,
  ): Promise<VirtualMCPEntity | null>;
  list(organizationId: string): Promise<VirtualMCPEntity[]>;
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

  // Virtual Tool CRUD methods
  listVirtualTools(virtualMcpId: string): Promise<VirtualToolEntity[]>;
  getVirtualTool(
    virtualMcpId: string,
    toolName: string,
  ): Promise<VirtualToolEntity | null>;
  createVirtualTool(
    virtualMcpId: string,
    data: VirtualToolCreateData,
    connectionDependencies: string[],
  ): Promise<VirtualToolEntity>;
  updateVirtualTool(
    virtualMcpId: string,
    toolName: string,
    data: VirtualToolUpdateData,
    connectionDependencies?: string[],
  ): Promise<VirtualToolEntity>;
  deleteVirtualTool(virtualMcpId: string, toolName: string): Promise<void>;

  // Indirect dependency management
  syncIndirectDependencies(
    virtualMcpId: string,
    connectionIds: string[],
  ): Promise<void>;
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
