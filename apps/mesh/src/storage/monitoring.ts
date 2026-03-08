/**
 * Monitoring Storage Implementation
 *
 * Handles CRUD operations for monitoring logs using Kysely (database-agnostic).
 * All logs are organization-scoped.
 */

import type { Kysely } from "kysely";
import { sql } from "kysely";
import { RegexRedactor } from "../monitoring/redactor";
import type { MonitoringStorage, PropertyFilters } from "./ports";
import type {
  AggregationFunction,
  Database,
  GroupByColumn,
  MonitoringLog,
} from "./types";
import { generatePrefixedId } from "@/shared/utils/generate-id";

export type { GroupByColumn };

export interface AggregationParams {
  organizationId: string;
  path: string; // JSONPath to extract, e.g., "$.usage.total_tokens"
  from: "input" | "output";
  aggregation: AggregationFunction;
  groupBy?: string; // Optional JSONPath for grouping (extracted from JSON)
  groupByColumn?: GroupByColumn; // Optional table column for grouping (takes priority over groupBy)
  interval?: string; // For timeseries: "1h", "1d"
  limit?: number; // Max number of groups to return (applies to groupBy/groupByColumn, ordered by value desc)
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
  groups?: Array<{
    key: string;
    value: number;
  }>;
  timeseries?: Array<{
    timestamp: string;
    value: number;
  }>;
}

// ============================================================================
// Monitoring Storage Implementation
// ============================================================================

export class SqlMonitoringStorage implements MonitoringStorage {
  private redactor: RegexRedactor;

  constructor(private db: Kysely<Database>) {
    this.redactor = new RegexRedactor();
  }

  /**
   * Get JSON property value extraction SQL fragment.
   * Uses PostgreSQL jsonb ->> operator (works with both PGlite and PostgreSQL).
   * Properties column is stored as text, so it needs a cast to jsonb.
   */
  private jsonExtract(column: string, key: string) {
    return sql`(${sql.ref(column)}::jsonb)->>${key}`;
  }

  /**
   * Get JSON property value wrapped in commas for "in" matching.
   * This enables searching for exact values within comma-separated strings.
   * e.g., ',Engineering,Sales,' LIKE '%,Engineering,%' matches
   * but ',Engineering,Sales,' LIKE '%,Eng,%' does NOT match
   */
  private jsonExtractWithCommas(column: string, key: string) {
    return sql`(',' || (${sql.ref(column)}::jsonb)->>${key} || ',')`;
  }

  /**
   * Escape SQL LIKE wildcards in a string value.
   * This ensures that '%' and '_' are treated as literal characters,
   * not as pattern matching wildcards.
   */
  private escapeLikeWildcards(value: string): string {
    // Escape the escape character first, then the wildcards
    return value
      .replace(/\\/g, "\\\\")
      .replace(/%/g, "\\%")
      .replace(/_/g, "\\_");
  }

  async log(event: MonitoringLog): Promise<void> {
    await this.logBatch([event]);
  }

  async logBatch(events: MonitoringLog[]): Promise<void> {
    if (events.length === 0) return;

    // Apply PII redaction to each event before storing
    const redactedEvents = events.map((event) => ({
      ...event,
      input: this.redactor.redact(event.input) as Record<string, unknown>,
      output: this.redactor.redact(event.output) as Record<string, unknown>,
    }));

    // Use transaction for atomic batch insert
    await this.db.transaction().execute(async (trx) => {
      await trx
        .insertInto("monitoring_logs")
        .values(redactedEvents.map((e) => this.toDbRow(e)))
        .execute();
    });
  }

  async query(filters: {
    organizationId?: string;
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
  }): Promise<{ logs: MonitoringLog[]; total: number }> {
    let query = this.db.selectFrom("monitoring_logs").selectAll();
    let countQuery = this.db
      .selectFrom("monitoring_logs")
      .select((eb) => eb.fn.countAll().as("count"));

    // Apply filters to both queries
    if (filters.organizationId) {
      query = query.where("organization_id", "=", filters.organizationId);
      countQuery = countQuery.where(
        "organization_id",
        "=",
        filters.organizationId,
      );
    }
    if (filters.connectionId) {
      query = query.where("connection_id", "=", filters.connectionId);
      countQuery = countQuery.where("connection_id", "=", filters.connectionId);
    }
    if (
      filters.excludeConnectionIds &&
      filters.excludeConnectionIds.length > 0
    ) {
      query = query.where(
        "connection_id",
        "not in",
        filters.excludeConnectionIds,
      );
      countQuery = countQuery.where(
        "connection_id",
        "not in",
        filters.excludeConnectionIds,
      );
    }
    if (filters.virtualMcpId) {
      query = query.where("virtual_mcp_id", "=", filters.virtualMcpId);
      countQuery = countQuery.where(
        "virtual_mcp_id",
        "=",
        filters.virtualMcpId,
      );
    }
    if (filters.toolName) {
      query = query.where("tool_name", "=", filters.toolName);
      countQuery = countQuery.where("tool_name", "=", filters.toolName);
    }
    if (filters.isError !== undefined) {
      const isErrorInt = filters.isError ? 1 : 0;
      query = query.where("is_error", "=", isErrorInt as never);
      countQuery = countQuery.where("is_error", "=", isErrorInt as never);
    }
    if (filters.startDate) {
      query = query.where(
        "timestamp",
        ">=",
        filters.startDate.toISOString() as never,
      );
      countQuery = countQuery.where(
        "timestamp",
        ">=",
        filters.startDate.toISOString() as never,
      );
    }
    if (filters.endDate) {
      query = query.where(
        "timestamp",
        "<=",
        filters.endDate.toISOString() as never,
      );
      countQuery = countQuery.where(
        "timestamp",
        "<=",
        filters.endDate.toISOString() as never,
      );
    }

    // Apply property filters
    if (filters.propertyFilters) {
      query = this.applyPropertyFilters(query, filters.propertyFilters);
      countQuery = this.applyPropertyFilters(
        countQuery,
        filters.propertyFilters,
      );
    }

    // Order by timestamp descending (most recent first)
    query = query.orderBy("timestamp", "desc");

    // Pagination (only applies to data query, not count)
    if (filters.limit) {
      query = query.limit(filters.limit);
    }
    if (filters.offset) {
      query = query.offset(filters.offset);
    }

    // Execute both queries in parallel
    const [rows, countResult] = await Promise.all([
      query.execute(),
      countQuery.executeTakeFirst(),
    ]);

    const total = Number(countResult?.count || 0);
    const logs = rows.map((row) => this.fromDbRow(row));

    return { logs, total };
  }

  async getStats(filters: {
    organizationId: string;
    startDate?: Date;
    endDate?: Date;
  }): Promise<{
    totalCalls: number;
    errorRate: number;
    avgDurationMs: number;
  }> {
    let query = this.db
      .selectFrom("monitoring_logs")
      .where("organization_id", "=", filters.organizationId);

    if (filters.startDate) {
      query = query.where(
        "timestamp",
        ">=",
        filters.startDate.toISOString() as never,
      );
    }
    if (filters.endDate) {
      query = query.where(
        "timestamp",
        "<=",
        filters.endDate.toISOString() as never,
      );
    }

    // Get total count, error count, and average duration using SQL aggregations
    const stats = await query
      .select([
        (eb) => eb.fn.countAll().as("total_count"),
        (eb) => eb.fn.sum(sql`${eb.ref("is_error")}::int`).as("error_count"),
        (eb) => eb.fn.avg("duration_ms").as("avg_duration"),
      ])
      .executeTakeFirst();

    const totalCalls = Number(stats?.total_count || 0);
    const errorCount = Number(stats?.error_count || 0);
    const avgDurationMs = Number(stats?.avg_duration || 0);

    return {
      totalCalls,
      errorRate: totalCalls > 0 ? errorCount / totalCalls : 0,
      avgDurationMs,
    };
  }

  // ============================================================================
  // Aggregation Methods (for Dashboard Widgets)
  // ============================================================================

  /**
   * Extract JSON value using JSONPath and aggregate across logs.
   * Supports groupBy for breakdown and interval for timeseries.
   */
  async aggregate(params: AggregationParams): Promise<AggregationResult> {
    const {
      organizationId,
      path,
      from,
      aggregation,
      groupBy,
      groupByColumn,
      interval,
      filters,
    } = params;

    // Determine which column to extract from
    const sourceColumn = from === "input" ? "input" : "output";

    // Build base query with filters
    let baseQuery = this.db
      .selectFrom("monitoring_logs")
      .where("organization_id", "=", organizationId);

    // Apply additional filters
    if (filters?.connectionIds && filters.connectionIds.length > 0) {
      baseQuery = baseQuery.where("connection_id", "in", filters.connectionIds);
    }
    if (filters?.virtualMcpIds && filters.virtualMcpIds.length > 0) {
      baseQuery = baseQuery.where(
        "virtual_mcp_id",
        "in",
        filters.virtualMcpIds,
      );
    }
    if (filters?.toolNames && filters.toolNames.length > 0) {
      baseQuery = baseQuery.where("tool_name", "in", filters.toolNames);
    }
    if (filters?.startDate) {
      baseQuery = baseQuery.where(
        "timestamp",
        ">=",
        filters.startDate.toISOString() as never,
      );
    }
    if (filters?.endDate) {
      baseQuery = baseQuery.where(
        "timestamp",
        "<=",
        filters.endDate.toISOString() as never,
      );
    }
    if (filters?.propertyFilters) {
      baseQuery = this.applyPropertyFilters(baseQuery, filters.propertyFilters);
    }

    // Get JSON extraction expression
    const valueExpr = this.jsonExtractPath(sourceColumn, path);

    // If we have groupByColumn (table column), use it directly (takes priority over groupBy JSONPath)
    if (groupByColumn) {
      const colRef = sql.ref(groupByColumn);
      let groupQuery = baseQuery
        .select([
          sql<string>`${colRef}`.as("group_key"),
          this.aggregationExpression(aggregation, valueExpr).as("agg_value"),
        ])
        .where(sql`${colRef}`, "is not", null)
        .groupBy(sql`${colRef}`)
        .orderBy(sql`agg_value`, "desc");

      if (params.limit) {
        groupQuery = groupQuery.limit(params.limit);
      }

      const rows = await groupQuery.execute();

      return {
        value: null,
        groups: rows.map((row) => ({
          key: String(row.group_key),
          value: Number(row.agg_value) || 0,
        })),
      };
    }

    // If we have groupBy JSONPath, return grouped results
    if (groupBy) {
      // Use text extraction for groupBy (it's typically a string like model name)
      const groupExpr = this.jsonExtractPathText(sourceColumn, groupBy);
      let groupQuery = baseQuery
        .select([
          sql<string>`${groupExpr}`.as("group_key"),
          this.aggregationExpression(aggregation, valueExpr).as("agg_value"),
        ])
        .where(sql`${groupExpr}`, "is not", null)
        .groupBy(sql`${groupExpr}`)
        .orderBy(sql`agg_value`, "desc");

      if (params.limit) {
        groupQuery = groupQuery.limit(params.limit);
      }

      const rows = await groupQuery.execute();

      return {
        value: null,
        groups: rows.map((row) => ({
          key: String(row.group_key),
          value: Number(row.agg_value) || 0,
        })),
      };
    }

    // If we have interval, return timeseries
    if (interval) {
      const bucketExpr = this.timeBucketExpression(interval);
      const rows = await baseQuery
        .select([
          bucketExpr.as("time_bucket"),
          this.aggregationExpression(aggregation, valueExpr).as("agg_value"),
        ])
        .groupBy(sql`time_bucket`)
        .orderBy(sql`time_bucket`)
        .execute();

      return {
        value: null,
        timeseries: rows.map((row) => ({
          timestamp: String(row.time_bucket),
          value: Number(row.agg_value) || 0,
        })),
      };
    }

    // Simple aggregation without grouping
    const result = await baseQuery
      .select([
        this.aggregationExpression(aggregation, valueExpr).as("agg_value"),
      ])
      .executeTakeFirst();

    return {
      value: result ? Number(result.agg_value) || 0 : null,
    };
  }

  /**
   * Count records that have a non-null value at the given JSONPath.
   * Used for preview to show how many records matched.
   */
  async countMatched(params: {
    organizationId: string;
    path: string;
    from: "input" | "output";
    filters?: {
      connectionIds?: string[];
      toolNames?: string[];
      startDate?: Date;
      endDate?: Date;
      propertyFilters?: PropertyFilters;
    };
  }): Promise<number> {
    const { organizationId, path, from, filters } = params;

    const sourceColumn = from === "input" ? "input" : "output";

    let query = this.db
      .selectFrom("monitoring_logs")
      .where("organization_id", "=", organizationId);

    // Apply filters
    if (filters?.connectionIds && filters.connectionIds.length > 0) {
      query = query.where("connection_id", "in", filters.connectionIds);
    }
    if (filters?.toolNames && filters.toolNames.length > 0) {
      query = query.where("tool_name", "in", filters.toolNames);
    }
    if (filters?.startDate) {
      query = query.where(
        "timestamp",
        ">=",
        filters.startDate.toISOString() as never,
      );
    }
    if (filters?.endDate) {
      query = query.where(
        "timestamp",
        "<=",
        filters.endDate.toISOString() as never,
      );
    }
    if (filters?.propertyFilters) {
      query = this.applyPropertyFilters(query, filters.propertyFilters);
    }

    // Only count records where the JSONPath extracts a non-null value
    const valueExpr = this.jsonExtractPathText(sourceColumn, path);
    const result = await query
      .where(sql`${valueExpr}`, "is not", null)
      .select((eb) => eb.fn.countAll().as("count"))
      .executeTakeFirst();

    return Number(result?.count || 0);
  }

  /**
   * Get JSON extraction SQL for a JSONPath (numeric value).
   * Converts "$.usage.total_tokens" to appropriate SQL.
   * Used for values that will be aggregated (sum, avg, etc.)
   */
  private jsonExtractPath(column: string, jsonPath: string) {
    const pathParts = jsonPath.replace(/^\$\.?/, "").split(".");
    const pathArray = `{${pathParts.join(",")}}`;
    return sql`(${sql.ref(column)}::jsonb #>> ${pathArray})::numeric`;
  }

  /**
   * Get JSON extraction SQL for a JSONPath (text value).
   * Used for groupBy fields which are typically strings.
   */
  private jsonExtractPathText(column: string, jsonPath: string) {
    const pathParts = jsonPath.replace(/^\$\.?/, "").split(".");
    const pathArray = `{${pathParts.join(",")}}`;
    return sql`(${sql.ref(column)}::jsonb #>> ${pathArray})`;
  }

  /**
   * Get aggregation SQL expression.
   */
  private aggregationExpression(
    fn: AggregationFunction,
    valueExpr: ReturnType<typeof sql>,
  ) {
    switch (fn) {
      case "sum":
        return sql`COALESCE(SUM(${valueExpr}), 0)`;
      case "avg":
        return sql`COALESCE(AVG(${valueExpr}), 0)`;
      case "min":
        return sql`MIN(${valueExpr})`;
      case "max":
        return sql`MAX(${valueExpr})`;
      case "count":
        return sql`COUNT(${valueExpr})`;
      case "count_all":
        // Counts all rows regardless of whether the JSON path has a value
        return sql`COUNT(*)`;
      case "last":
        // For "last", we'd need a subquery - simplified to max for now
        return sql`MAX(${valueExpr})`;
      default:
        return sql`SUM(${valueExpr})`;
    }
  }

  /**
   * Get time bucket expression for timeseries grouping.
   */
  private timeBucketExpression(interval: string) {
    const match = interval.match(/^(\d+)([mhd])$/);
    if (!match) {
      throw new Error(
        `Invalid interval format: ${interval}. Use format like "1h", "1d", "15m"`,
      );
    }

    const [, amountStr, unit] = match;
    if (!amountStr || !unit) {
      throw new Error(`Invalid interval format: ${interval}`);
    }
    const amount = parseInt(amountStr, 10);

    let truncUnit: string;
    switch (unit) {
      case "m":
        truncUnit = "minute";
        break;
      case "h":
        truncUnit = "hour";
        break;
      case "d":
        truncUnit = "day";
        break;
      default:
        truncUnit = "hour";
    }
    if (amount === 1) {
      return sql`date_trunc(${truncUnit}, timestamp::timestamp)`;
    }
    const secondsPerUnit = unit === "m" ? 60 : unit === "h" ? 3600 : 86400;
    const bucketSeconds = amount * secondsPerUnit;
    return sql`to_timestamp(floor(extract(epoch from timestamp::timestamp) / ${bucketSeconds}) * ${bucketSeconds})`;
  }

  // ============================================================================
  // Private Helper Methods
  // ============================================================================

  /**
   * Apply property filters to a Kysely query builder.
   * Supports exact match, exists, pattern (LIKE), and in-value matching.
   * Reused by query(), aggregate(), and countMatched().
   */
  // deno-lint-ignore no-explicit-any
  private applyPropertyFilters<T extends { where: (...args: any[]) => any }>(
    query: T,
    pf: PropertyFilters,
  ): T {
    const { properties, propertyKeys, propertyPatterns, propertyInValues } = pf;

    // Exact match: property key=value
    if (properties) {
      for (const [key, value] of Object.entries(properties)) {
        const jsonExpr = this.jsonExtract("properties", key);
        query = query.where(jsonExpr as never, "=", value as never);
      }
    }

    // Exists: check if property key exists
    if (propertyKeys && propertyKeys.length > 0) {
      for (const key of propertyKeys) {
        const jsonExpr = this.jsonExtract("properties", key);
        query = query.where(jsonExpr as never, "is not", null as never);
      }
    }

    // Pattern match: property value matches pattern (using ILIKE)
    if (propertyPatterns) {
      for (const [key, pattern] of Object.entries(propertyPatterns)) {
        const jsonExpr = this.jsonExtract("properties", key);
        query = query.where(jsonExpr as never, "ilike", pattern as never);
      }
    }

    // In match: check if value exists in comma-separated property value
    // This enables exact matching within arrays stored as comma-separated strings
    // e.g., user_tags="Engineering,Sales" with value="Engineering" will match
    if (propertyInValues) {
      for (const [key, value] of Object.entries(propertyInValues)) {
        const inExpr = this.jsonExtractWithCommas("properties", key);
        const escapedValue = this.escapeLikeWildcards(value);
        const searchPattern = `%,${escapedValue},%`;
        const likeCondition = sql`${inExpr} LIKE ${searchPattern} ESCAPE '\\'`;
        query = query.where(likeCondition as never);
      }
    }

    return query;
  }

  private toDbRow(log: MonitoringLog) {
    const id = log.id || generatePrefixedId("log");

    return {
      id,
      organization_id: log.organizationId,
      connection_id: log.connectionId,
      connection_title: log.connectionTitle,
      tool_name: log.toolName,
      input: JSON.stringify(log.input),
      output: JSON.stringify(log.output),
      is_error: log.isError ? 1 : 0,
      error_message: log.errorMessage || null,
      duration_ms: log.durationMs,
      timestamp:
        log.timestamp instanceof Date
          ? log.timestamp.toISOString()
          : log.timestamp,
      user_id: log.userId || null,
      request_id: log.requestId,
      user_agent: log.userAgent || null,
      virtual_mcp_id: log.virtualMcpId || null,
      properties: log.properties ? JSON.stringify(log.properties) : null,
    };
  }

  private fromDbRow(row: {
    id: string;
    organization_id: string;
    connection_id: string;
    connection_title: string;
    tool_name: string;
    input: string | Record<string, unknown>;
    output: string | Record<string, unknown>;
    is_error: boolean | number;
    error_message: string | null;
    duration_ms: number;
    timestamp: string | Date;
    user_id: string | null;
    request_id: string;
    user_agent: string | null;
    virtual_mcp_id: string | null;
    properties: string | Record<string, string> | null;
  }): MonitoringLog {
    const input =
      typeof row.input === "string" ? JSON.parse(row.input) : row.input;
    const output =
      typeof row.output === "string" ? JSON.parse(row.output) : row.output;
    const timestamp =
      typeof row.timestamp === "string"
        ? new Date(row.timestamp)
        : row.timestamp;
    const properties = row.properties
      ? typeof row.properties === "string"
        ? JSON.parse(row.properties)
        : row.properties
      : null;

    return {
      id: row.id,
      organizationId: row.organization_id,
      connectionId: row.connection_id,
      connectionTitle: row.connection_title,
      toolName: row.tool_name,
      input,
      output,
      isError: Boolean(row.is_error),
      errorMessage: row.error_message,
      durationMs: row.duration_ms,
      timestamp,
      userId: row.user_id,
      requestId: row.request_id,
      userAgent: row.user_agent,
      virtualMcpId: row.virtual_mcp_id,
      properties,
    };
  }
}
