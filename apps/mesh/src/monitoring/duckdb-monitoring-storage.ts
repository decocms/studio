import type { MonitoringStorage, PropertyFilters } from "../storage/ports";
import type {
  MonitoringLog,
  AggregationFunction,
  AggregationParams,
  AggregationResult,
  GroupByColumn,
} from "../storage/types";
import { DuckDBProvider } from "./duckdb-provider";
import { getGlobPattern, dateRangeToGlobRange } from "./parquet-paths";
import { assertSafeJsonPath, assertSafeIdentifier } from "./sql-safety";

export type { AggregationParams, AggregationResult, GroupByColumn };

/**
 * Monitoring storage backed by DuckDB reading Parquet files.
 *
 * Replaces SqlMonitoringStorage. Uses DuckDB's read_parquet() with glob
 * patterns to scan time-partitioned Parquet files. Provides the same
 * MonitoringStorage interface so MCP tools work unchanged.
 */
export class DuckDBMonitoringStorage implements MonitoringStorage {
  private duckdb: DuckDBProvider;
  private basePath: string;

  constructor(basePath: string) {
    if (!basePath) throw new Error("basePath is required");
    this.basePath = basePath;
    this.duckdb = new DuckDBProvider(":memory:");
  }

  /**
   * Build the Parquet source expression, optionally narrowing the glob
   * to a date range for better performance.
   */
  private getParquetSource(startDate?: Date, endDate?: Date): string {
    const range = dateRangeToGlobRange(startDate, endDate);
    const glob = getGlobPattern(this.basePath, range ?? undefined);
    return `read_parquet('${glob}', union_by_name=true, hive_partitioning=false)`;
  }

  /**
   * Wrap a query against Parquet files in try/catch to handle the case
   * where no Parquet files exist yet (empty glob returns no files).
   */
  private async safeQuery<T>(sql: string, ...params: unknown[]): Promise<T[]> {
    try {
      return await this.duckdb.all<T>(sql, ...params);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("No files found") || msg.includes("read_parquet")) {
        return [];
      }
      throw err;
    }
  }

  /**
   * log() and logBatch() are no-ops.
   * Writes now go through ParquetSpanExporter via OTel spans.
   */
  async log(_event: MonitoringLog): Promise<void> {
    // No-op: writes go through ParquetSpanExporter
  }

  async logBatch(_events: MonitoringLog[]): Promise<void> {
    // No-op: writes go through ParquetSpanExporter
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
    if (!filters.organizationId) {
      throw new Error("organizationId is required for monitoring queries");
    }

    const { where, params } = this.buildWhereClause(filters);
    const limit = filters.limit ?? 100;
    const offset = filters.offset ?? 0;
    const parquetSource = this.getParquetSource(
      filters.startDate,
      filters.endDate,
    );

    const sql = `
      SELECT *, COUNT(*) OVER() as _total
      FROM ${parquetSource}
      ${where}
      ORDER BY "timestamp" DESC
      LIMIT ${limit} OFFSET ${offset}
    `;
    const rows = await this.safeQuery<Record<string, unknown>>(sql, ...params);

    const total =
      rows.length > 0
        ? Number((rows[0] as Record<string, unknown>)._total ?? 0)
        : 0;
    const logs = rows.map((row) => this.rowToMonitoringLog(row));

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
    if (!filters.organizationId) {
      throw new Error("organizationId is required for monitoring queries");
    }

    const { where, params } = this.buildWhereClause(filters);
    const parquetSource = this.getParquetSource(
      filters.startDate,
      filters.endDate,
    );

    const sql = `
      SELECT
        count(*) as total_calls,
        COALESCE(sum(CASE WHEN is_error THEN 1 ELSE 0 END)::DOUBLE / NULLIF(count(*), 0), 0) as error_rate,
        COALESCE(avg(duration_ms), 0) as avg_duration_ms
      FROM ${parquetSource}
      ${where}
    `;

    const rows = await this.safeQuery<{
      total_calls: number;
      error_rate: number;
      avg_duration_ms: number;
    }>(sql, ...params);

    const row = rows[0];
    const totalCalls = Number(row?.total_calls ?? 0);
    if (!row || totalCalls === 0) {
      return { totalCalls: 0, errorRate: 0, avgDurationMs: 0 };
    }

    return {
      totalCalls,
      errorRate: Number(row.error_rate),
      avgDurationMs: Number(row.avg_duration_ms),
    };
  }

  async aggregate(params: AggregationParams): Promise<AggregationResult> {
    if (!params.organizationId) {
      throw new Error("organizationId is required for monitoring queries");
    }

    const { where, params: whereParams } = this.buildWhereClause({
      organizationId: params.organizationId,
      ...params.filters,
    });
    const parquetSource = this.getParquetSource(
      params.filters?.startDate,
      params.filters?.endDate,
    );

    // Validate user-supplied paths against SQL injection
    assertSafeJsonPath(params.path);
    if (params.groupBy) assertSafeJsonPath(params.groupBy);
    if (params.groupByColumn) assertSafeIdentifier(params.groupByColumn);

    // Build the value expression (JSONPath extraction)
    const valueExpr = this.buildValueExpression(
      params.path,
      params.from,
      params.aggregation,
    );

    // Build aggregation expression
    const aggExpr = this.buildAggExpression(params.aggregation, valueExpr);

    // Determine grouping
    const groupByExpr = params.groupByColumn
      ? params.groupByColumn
      : params.groupBy
        ? this.buildJsonExtract(params.from, params.groupBy)
        : null;

    if (params.interval && groupByExpr) {
      return this.queryTimeseriesGrouped(
        aggExpr,
        groupByExpr,
        params.interval,
        where,
        whereParams,
        parquetSource,
        params.limit,
      );
    } else if (params.interval) {
      return this.queryTimeseries(
        aggExpr,
        params.interval,
        where,
        whereParams,
        parquetSource,
      );
    } else if (groupByExpr) {
      return this.queryGrouped(
        aggExpr,
        groupByExpr,
        where,
        whereParams,
        parquetSource,
        params.limit,
      );
    } else {
      return this.queryScalar(aggExpr, where, whereParams, parquetSource);
    }
  }

  async countMatched(params: {
    organizationId: string;
    path: string;
    from: "input" | "output";
    filters?: AggregationParams["filters"];
  }): Promise<number> {
    if (!params.organizationId) {
      throw new Error("organizationId is required for monitoring queries");
    }

    assertSafeJsonPath(params.path);

    const { where, params: whereParams } = this.buildWhereClause({
      organizationId: params.organizationId,
      ...params.filters,
    });
    const parquetSource = this.getParquetSource(
      params.filters?.startDate,
      params.filters?.endDate,
    );

    const jsonPath = params.path.startsWith("$.")
      ? params.path
      : `$.${params.path}`;
    const extract = `json_extract_string(${params.from}, '${jsonPath}')`;

    const nullCheck = `${extract} IS NOT NULL`;
    const fullWhere = where
      ? `${where} AND ${nullCheck}`
      : `WHERE ${nullCheck}`;

    const sql = `
      SELECT count(*) as cnt
      FROM ${parquetSource}
      ${fullWhere}
    `;

    const rows = await this.safeQuery<{ cnt: number }>(sql, ...whereParams);
    return Number(rows[0]?.cnt ?? 0);
  }

  async close(): Promise<void> {
    await this.duckdb.close();
  }

  // --- Private Helpers ---

  private buildWhereClause(filters: {
    organizationId?: string;
    connectionId?: string;
    excludeConnectionIds?: string[];
    virtualMcpId?: string;
    toolName?: string;
    isError?: boolean;
    startDate?: Date;
    endDate?: Date;
    connectionIds?: string[];
    virtualMcpIds?: string[];
    toolNames?: string[];
    propertyFilters?: PropertyFilters;
  }): { where: string; params: unknown[] } {
    const conditions: string[] = [];
    const params: unknown[] = [];

    if (filters.organizationId) {
      conditions.push("organization_id = ?");
      params.push(filters.organizationId);
    }

    if (filters.connectionId) {
      conditions.push("connection_id = ?");
      params.push(filters.connectionId);
    }

    if (filters.excludeConnectionIds?.length) {
      const placeholders = filters.excludeConnectionIds
        .map(() => "?")
        .join(", ");
      conditions.push(`connection_id NOT IN (${placeholders})`);
      params.push(...filters.excludeConnectionIds);
    }

    if (filters.virtualMcpId) {
      conditions.push("virtual_mcp_id = ?");
      params.push(filters.virtualMcpId);
    }

    if (filters.toolName) {
      conditions.push("tool_name = ?");
      params.push(filters.toolName);
    }

    if (filters.isError !== undefined) {
      conditions.push("is_error = ?");
      params.push(filters.isError);
    }

    if (filters.startDate) {
      conditions.push(`"timestamp" >= ?`);
      params.push(filters.startDate.toISOString());
    }

    if (filters.endDate) {
      conditions.push(`"timestamp" <= ?`);
      params.push(filters.endDate.toISOString());
    }

    // Array filters (from aggregation)
    if (filters.connectionIds?.length) {
      const placeholders = filters.connectionIds.map(() => "?").join(", ");
      conditions.push(`connection_id IN (${placeholders})`);
      params.push(...filters.connectionIds);
    }

    if (filters.virtualMcpIds?.length) {
      const placeholders = filters.virtualMcpIds.map(() => "?").join(", ");
      conditions.push(`virtual_mcp_id IN (${placeholders})`);
      params.push(...filters.virtualMcpIds);
    }

    if (filters.toolNames?.length) {
      const placeholders = filters.toolNames.map(() => "?").join(", ");
      conditions.push(`tool_name IN (${placeholders})`);
      params.push(...filters.toolNames);
    }

    // Property filters
    if (filters.propertyFilters) {
      this.applyPropertyFilters(filters.propertyFilters, conditions, params);
    }

    const where =
      conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

    return { where, params };
  }

  private applyPropertyFilters(
    pf: PropertyFilters,
    conditions: string[],
    params: unknown[],
  ): void {
    if (pf.properties) {
      for (const [key, value] of Object.entries(pf.properties)) {
        assertSafeJsonPath(key);
        conditions.push(`json_extract_string(properties, '$.${key}') = ?`);
        params.push(value);
      }
    }

    if (pf.propertyKeys) {
      for (const key of pf.propertyKeys) {
        assertSafeJsonPath(key);
        conditions.push(
          `json_extract_string(properties, '$.${key}') IS NOT NULL`,
        );
      }
    }

    if (pf.propertyPatterns) {
      for (const [key, pattern] of Object.entries(pf.propertyPatterns)) {
        assertSafeJsonPath(key);
        conditions.push(`json_extract_string(properties, '$.${key}') LIKE ?`);
        params.push(pattern);
      }
    }

    if (pf.propertyInValues) {
      for (const [key, value] of Object.entries(pf.propertyInValues)) {
        assertSafeJsonPath(key);
        conditions.push(
          `(',' || json_extract_string(properties, '$.${key}') || ',') LIKE ?`,
        );
        params.push(`%,${value},%`);
      }
    }
  }

  private buildValueExpression(
    path: string,
    from: "input" | "output",
    aggregation: AggregationFunction,
  ): string {
    if (aggregation === "count_all") {
      return "1";
    }
    const jsonPath = path.startsWith("$.") ? path : `$.${path}`;
    if (aggregation === "count" || aggregation === "last") {
      return `json_extract_string(${from}, '${jsonPath}')`;
    }
    return `CAST(json_extract_string(${from}, '${jsonPath}') AS DOUBLE)`;
  }

  private buildAggExpression(
    aggregation: AggregationFunction,
    valueExpr: string,
  ): string {
    switch (aggregation) {
      case "sum":
        return `COALESCE(sum(${valueExpr}), 0)`;
      case "avg":
        return `COALESCE(avg(${valueExpr}), 0)`;
      case "min":
        return `COALESCE(min(${valueExpr}), 0)`;
      case "max":
        return `COALESCE(max(${valueExpr}), 0)`;
      case "count":
        return `count(${valueExpr})`;
      case "count_all":
        return "count(*)";
      case "last":
        return `last(${valueExpr} ORDER BY "timestamp" DESC)`;
      default:
        return `count(*)`;
    }
  }

  private buildJsonExtract(from: string, path: string): string {
    const jsonPath = path.startsWith("$.") ? path : `$.${path}`;
    return `json_extract_string(${from}, '${jsonPath}')`;
  }

  private async queryScalar(
    aggExpr: string,
    where: string,
    params: unknown[],
    parquetSource: string,
  ): Promise<AggregationResult> {
    const sql = `SELECT ${aggExpr} as value FROM ${parquetSource} ${where}`;
    const rows = await this.safeQuery<{ value: unknown }>(sql, ...params);
    const raw = rows[0]?.value;
    return { value: raw != null ? Number(raw) : null };
  }

  private async queryGrouped(
    aggExpr: string,
    groupByExpr: string,
    where: string,
    params: unknown[],
    parquetSource: string,
    limit?: number,
  ): Promise<AggregationResult> {
    const limitClause = limit ? `LIMIT ${limit}` : "";
    const sql = `
      SELECT ${groupByExpr} as grp, ${aggExpr} as value
      FROM ${parquetSource}
      ${where}
      GROUP BY grp
      ORDER BY value DESC
      ${limitClause}
    `;
    const rows = await this.safeQuery<{ grp: string; value: number }>(
      sql,
      ...params,
    );

    return {
      value: null,
      groups: rows.map((r) => ({
        key: String(r.grp ?? "null"),
        value: Number(r.value),
      })),
    };
  }

  private async queryTimeseries(
    aggExpr: string,
    interval: string,
    where: string,
    params: unknown[],
    parquetSource: string,
  ): Promise<AggregationResult> {
    const bucket = this.intervalToBucket(interval);
    const sql = `
      SELECT ${bucket} as ts, ${aggExpr} as value
      FROM ${parquetSource}
      ${where}
      GROUP BY ts
      ORDER BY ts ASC
    `;
    const rows = await this.safeQuery<{ ts: string; value: number }>(
      sql,
      ...params,
    );

    return {
      value: null,
      timeseries: rows.map((r) => ({
        timestamp: String(r.ts),
        value: Number(r.value),
      })),
    };
  }

  private async queryTimeseriesGrouped(
    aggExpr: string,
    _groupByExpr: string,
    interval: string,
    where: string,
    params: unknown[],
    parquetSource: string,
    _limit?: number,
  ): Promise<AggregationResult> {
    // Fall back to ungrouped timeseries
    return this.queryTimeseries(
      aggExpr,
      interval,
      where,
      params,
      parquetSource,
    );
  }

  private intervalToBucket(interval: string): string {
    const map: Record<string, string> = {
      "1m": "minute",
      "5m": "minute",
      "1h": "hour",
      "1d": "day",
      "1w": "week",
      "1M": "month",
    };
    const part = map[interval] ?? "hour";
    return `date_trunc('${part}', "timestamp")`;
  }

  private rowToMonitoringLog(row: Record<string, unknown>): MonitoringLog {
    return {
      id: String(row.id ?? ""),
      organizationId: String(row.organization_id ?? ""),
      connectionId: String(row.connection_id ?? ""),
      connectionTitle: String(row.connection_title ?? ""),
      toolName: String(row.tool_name ?? ""),
      input: this.parseJson(row.input) ?? {},
      output: this.parseJson(row.output) ?? {},
      isError: Boolean(row.is_error),
      errorMessage:
        row.error_message != null ? String(row.error_message) : undefined,
      durationMs: Number(row.duration_ms ?? 0),
      timestamp:
        row.timestamp instanceof Date
          ? row.timestamp
          : new Date(String(row.timestamp)),
      userId: row.user_id != null ? String(row.user_id) : null,
      requestId: String(row.request_id ?? ""),
      userAgent: row.user_agent != null ? String(row.user_agent) : undefined,
      virtualMcpId:
        row.virtual_mcp_id != null ? String(row.virtual_mcp_id) : undefined,
      properties: this.parseJson(row.properties) as
        | Record<string, string>
        | undefined,
    };
  }

  private parseJson(value: unknown): Record<string, unknown> | undefined {
    if (value == null) return undefined;
    if (typeof value === "object") return value as Record<string, unknown>;
    try {
      return JSON.parse(String(value));
    } catch {
      return undefined;
    }
  }
}
