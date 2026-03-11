/**
 * ClickHouseMonitoringStorage
 *
 * Implements MonitoringStorage using ClickHouse SQL via QueryEngine.
 * Local dev uses chdb (embedded ClickHouse) to query NDJSON files on disk.
 *
 * Writes flow through the OTel pipeline (NDJSONLogExporter).
 * This adapter is read-only — it queries NDJSON files on disk.
 */

import type { QueryEngine } from "../monitoring/query-engine";
import { createMonitoringEngine } from "../monitoring/query-engine";
import { DEFAULT_METRICS_DIR } from "../monitoring/schema";
import type { MonitoringLog } from "./types";
import type {
  AggregationParams,
  AggregationResult,
  GroupByColumn,
  MonitoringStorage,
  PropertyFilters,
} from "./ports";

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

/** Escape a string value for safe use in SQL single-quoted literals. */
function esc(value: string): string {
  return value.replace(/\0/g, "").replace(/\\/g, "\\\\").replace(/'/g, "''");
}

/** Allowed groupByColumn values. */
const ALLOWED_GROUP_BY_COLUMNS = new Set<GroupByColumn>([
  "connection_id",
  "connection_title",
  "user_id",
  "tool_name",
  "virtual_mcp_id",
]);

/** Validate a groupByColumn identifier. */
function validateGroupByColumn(col: string): GroupByColumn {
  if (!ALLOWED_GROUP_BY_COLUMNS.has(col as GroupByColumn)) {
    throw new Error(`Invalid groupByColumn: ${col}`);
  }
  return col as GroupByColumn;
}

/** Strict JSONPath regex: allows $.key.subkey or key.subkey forms. */
const JSONPATH_REGEX = /^(\$\.)?[a-zA-Z0-9_]+(\.[a-zA-Z0-9_]+)*$/;

/** Validate and normalise a JSONPath expression. Returns the $.key.subkey form. */
function validateJsonPath(path: string): string {
  if (!JSONPATH_REGEX.test(path)) {
    throw new Error(`Invalid JSONPath: ${path}`);
  }
  // Normalise to $.key form
  if (path.startsWith("$.")) return path;
  if (path.startsWith(".")) return `$${path}`;
  return `$.${path}`;
}

/**
 * Convert a validated JSONPath ($.key or $.key.subkey) to ClickHouse
 * JSONExtract key arguments: 'key' or 'key', 'subkey'
 */
function jsonPathToChKeys(jsonPath: string): string {
  // Remove leading $. then split by .
  const keys = jsonPath.replace(/^\$\./, "").split(".");
  return keys.map((k) => `'${esc(k)}'`).join(", ");
}

/** Interval regex and max amounts. */
const INTERVAL_REGEX = /^(\d+)([mhd])$/;
const MAX_INTERVAL_AMOUNTS: Record<string, number> = {
  m: 525960,
  h: 8760,
  d: 365,
};

function parseInterval(interval: string): { amount: number; unit: string } {
  const match = INTERVAL_REGEX.exec(interval);
  if (!match || !match[1] || !match[2]) {
    throw new Error(`Invalid interval: ${interval}`);
  }
  const amount = parseInt(match[1], 10);
  const unit = match[2];
  const max = MAX_INTERVAL_AMOUNTS[unit]!;
  if (amount < 1 || amount > max) {
    throw new Error(
      `Invalid interval amount: ${amount}${unit} (max ${max}${unit})`,
    );
  }
  return { amount, unit };
}

function intervalToSQL(interval: string): string {
  const { amount, unit } = parseInterval(interval);
  const unitMap: Record<string, string> = {
    m: "MINUTE",
    h: "HOUR",
    d: "DAY",
  };
  const sqlUnit = unitMap[unit];
  return `toStartOfInterval(parseDateTime64BestEffort(toString(timestamp)), INTERVAL ${amount} ${sqlUnit})`;
}

// ---------------------------------------------------------------------------
// Row mapping
// ---------------------------------------------------------------------------

function safeJsonParse(val: unknown): Record<string, unknown> {
  if (val === null || val === undefined) return {};
  if (typeof val === "object") return val as Record<string, unknown>;
  try {
    return JSON.parse(String(val));
  } catch {
    return {};
  }
}

function toMonitoringLog(row: Record<string, unknown>): MonitoringLog {
  return {
    id: String(row.id ?? ""),
    organizationId: String(row.organization_id ?? ""),
    connectionId: String(row.connection_id ?? ""),
    connectionTitle: String(row.connection_title ?? ""),
    toolName: String(row.tool_name ?? ""),
    input: safeJsonParse(row.input),
    output: safeJsonParse(row.output),
    isError:
      row.is_error === 1 || row.is_error === true || row.is_error === "1",
    errorMessage: row.error_message != null ? String(row.error_message) : null,
    durationMs: Number(row.duration_ms ?? 0),
    timestamp: (() => {
      if (row.timestamp instanceof Date) return row.timestamp.toISOString();
      const str = String(row.timestamp ?? "");
      // chdb returns "YYYY-MM-DD HH:MM:SS.nnnnnnnnn" — convert to ISO 8601
      const d = new Date(str.includes("T") ? str : str.replace(" ", "T") + "Z");
      return Number.isNaN(d.getTime()) ? str : d.toISOString();
    })(),
    userId: row.user_id != null ? String(row.user_id) : null,
    requestId: String(row.request_id ?? ""),
    userAgent: row.user_agent != null ? String(row.user_agent) : null,
    virtualMcpId:
      row.virtual_mcp_id != null ? String(row.virtual_mcp_id) : null,
    properties: row.properties
      ? (safeJsonParse(row.properties) as Record<string, string>)
      : null,
  };
}

// ---------------------------------------------------------------------------
// Property filter SQL builder (ClickHouse syntax)
// ---------------------------------------------------------------------------

function buildPropertyFilterClauses(filters: PropertyFilters): string[] {
  const clauses: string[] = [];

  if (filters.properties) {
    for (const [key, value] of Object.entries(filters.properties)) {
      const k = esc(key);
      const v = esc(value);
      clauses.push(`JSONExtractString(properties, '${k}') = '${v}'`);
    }
  }

  if (filters.propertyKeys) {
    for (const key of filters.propertyKeys) {
      const k = esc(key);
      clauses.push(
        `JSONExtractString(properties, '${k}') IS NOT NULL AND JSONExtractString(properties, '${k}') != ''`,
      );
    }
  }

  if (filters.propertyPatterns) {
    for (const [key, pattern] of Object.entries(filters.propertyPatterns)) {
      const k = esc(key);
      const p = esc(pattern);
      clauses.push(`JSONExtractString(properties, '${k}') ILIKE '${p}'`);
    }
  }

  if (filters.propertyInValues) {
    for (const [key, value] of Object.entries(filters.propertyInValues)) {
      const k = esc(key);
      const v = esc(value);
      clauses.push(
        `has(splitByChar(',', JSONExtractString(properties, '${k}')), '${v}')`,
      );
    }
  }

  return clauses;
}

// ---------------------------------------------------------------------------
// Timestamp filter helper (ClickHouse syntax)
// ---------------------------------------------------------------------------

function buildCommonFilterClauses(filters?: {
  connectionIds?: string[];
  toolNames?: string[];
  virtualMcpIds?: string[];
  startDate?: Date;
  endDate?: Date;
  propertyFilters?: PropertyFilters;
}): string[] {
  if (!filters) return [];
  const clauses: string[] = [];
  if (filters.connectionIds?.length) {
    const ids = filters.connectionIds.map((id) => `'${esc(id)}'`).join(",");
    clauses.push(`connection_id IN (${ids})`);
  }
  if (filters.toolNames?.length) {
    const names = filters.toolNames.map((n) => `'${esc(n)}'`).join(",");
    clauses.push(`tool_name IN (${names})`);
  }
  if (filters.virtualMcpIds?.length) {
    const ids = filters.virtualMcpIds.map((id) => `'${esc(id)}'`).join(",");
    clauses.push(`virtual_mcp_id IN (${ids})`);
  }
  if (filters.startDate) {
    clauses.push(tsGte(filters.startDate));
  }
  if (filters.endDate) {
    clauses.push(tsLte(filters.endDate));
  }
  if (filters.propertyFilters) {
    clauses.push(...buildPropertyFilterClauses(filters.propertyFilters));
  }
  return clauses;
}

function tsGte(date: Date): string {
  return `parseDateTime64BestEffort(toString(timestamp)) >= parseDateTime64BestEffort('${date.toISOString()}')`;
}

function tsLte(date: Date): string {
  return `parseDateTime64BestEffort(toString(timestamp)) <= parseDateTime64BestEffort('${date.toISOString()}')`;
}

// ---------------------------------------------------------------------------
// ClickHouseMonitoringStorage
// ---------------------------------------------------------------------------

export class ClickHouseMonitoringStorage implements MonitoringStorage {
  private metricEngine: QueryEngine;
  private metricSource: string;

  constructor(
    private engine: QueryEngine,
    private source: string,
    metricEngine?: QueryEngine,
    metricSource?: string,
  ) {
    if (metricEngine && metricSource) {
      this.metricEngine = metricEngine;
      this.metricSource = metricSource;
    } else {
      const { engine: me, source: ms } = createMonitoringEngine({
        basePath: DEFAULT_METRICS_DIR,
      });
      this.metricEngine = me;
      this.metricSource = ms;
    }
  }

  async query(filters: {
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
  }): Promise<{ logs: MonitoringLog[]; total: number }> {
    if (!filters.organizationId) {
      throw new Error("organizationId is required");
    }

    const where: string[] = [
      `organization_id = '${esc(filters.organizationId)}'`,
    ];

    if (filters.connectionId) {
      where.push(`connection_id = '${esc(filters.connectionId)}'`);
    }
    if (filters.excludeConnectionIds?.length) {
      const ids = filters.excludeConnectionIds
        .map((id) => `'${esc(id)}'`)
        .join(",");
      where.push(`connection_id NOT IN (${ids})`);
    }
    if (filters.virtualMcpId) {
      where.push(`virtual_mcp_id = '${esc(filters.virtualMcpId)}'`);
    }
    if (filters.toolName) {
      where.push(`tool_name = '${esc(filters.toolName)}'`);
    }
    if (filters.isError !== undefined) {
      where.push(`is_error = ${filters.isError ? 1 : 0}`);
    }
    if (filters.startDate) {
      where.push(tsGte(filters.startDate));
    }
    if (filters.endDate) {
      where.push(tsLte(filters.endDate));
    }
    if (filters.propertyFilters) {
      where.push(...buildPropertyFilterClauses(filters.propertyFilters));
    }

    const MAX_LIMIT = 1000;
    const limit = Math.min(
      Math.max(1, Math.floor(filters.limit ?? 50)),
      MAX_LIMIT,
    );
    const offset = Math.max(0, Math.floor(filters.offset ?? 0));

    const sql = `SELECT *, count(*) OVER () AS _total FROM ${this.source} WHERE ${where.join(" AND ")} ORDER BY timestamp DESC LIMIT ${limit} OFFSET ${offset}`;

    const rows = await this.engine.query(sql);

    if (rows.length === 0) {
      return { logs: [], total: 0 };
    }

    const total = Number(rows[0]!._total ?? 0);
    const logs = rows.map(toMonitoringLog);

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
      throw new Error("organizationId is required");
    }

    const where: string[] = [
      `organization_id = '${esc(filters.organizationId)}'`,
    ];

    if (filters.startDate) {
      where.push(tsGte(filters.startDate));
    }
    if (filters.endDate) {
      where.push(tsLte(filters.endDate));
    }

    const sql = `SELECT count(*) AS total_calls, coalesce(sum(CASE WHEN is_error = 1 THEN 1.0 ELSE 0.0 END) / NULLIF(count(*), 0), 0) AS error_rate, coalesce(avg(duration_ms), 0) AS avg_duration_ms FROM ${this.source} WHERE ${where.join(" AND ")}`;

    const rows = await this.engine.query(sql);
    const row = rows[0] ?? {};

    return {
      totalCalls: Number(row.total_calls ?? 0),
      errorRate: Number(row.error_rate ?? 0),
      avgDurationMs: Number(row.avg_duration_ms ?? 0),
    };
  }

  async aggregate(params: AggregationParams): Promise<AggregationResult> {
    if (!params.organizationId) {
      throw new Error("organizationId is required");
    }

    const jsonPath = validateJsonPath(params.path);
    const sourceCol = params.from === "input" ? "input" : "output";
    const chKeys = jsonPathToChKeys(jsonPath);

    // Build the value expression using ClickHouse JSONExtract functions
    const valueExpr =
      params.aggregation === "count" || params.aggregation === "count_all"
        ? "1"
        : `JSONExtractFloat(${sourceCol}, ${chKeys})`;

    // Build aggregation expression
    const aggExpr = buildAggExpr(params.aggregation, valueExpr);

    // Build WHERE clause
    const where: string[] = [
      `organization_id = '${esc(params.organizationId)}'`,
    ];

    // For count (not count_all), only count rows where the path exists and is non-null
    if (params.aggregation === "count") {
      where.push(`JSONExtractString(${sourceCol}, ${chKeys}) IS NOT NULL`);
      where.push(`JSONExtractString(${sourceCol}, ${chKeys}) != ''`);
    }

    // Exclude count_all from null filtering — it counts all rows
    if (params.aggregation !== "count" && params.aggregation !== "count_all") {
      where.push(`JSONExtractString(${sourceCol}, ${chKeys}) IS NOT NULL`);
      where.push(`JSONExtractString(${sourceCol}, ${chKeys}) != ''`);
    }

    where.push(...buildCommonFilterClauses(params.filters));

    const whereClause = where.join(" AND ");

    const rowLimit = Math.min(
      Math.max(1, Math.floor(params.limit ?? 10000)),
      10000,
    );

    // --- groupByColumn (takes priority) ---
    if (params.groupByColumn) {
      const col = validateGroupByColumn(params.groupByColumn);
      const sql = `SELECT ${col} AS group_key, ${aggExpr} AS value FROM ${this.source} WHERE ${whereClause} GROUP BY ${col} ORDER BY value DESC LIMIT ${rowLimit}`;
      const rows = await this.engine.query(sql);
      return {
        value: null,
        groups: rows.map((r) => ({
          key: String(r.group_key ?? ""),
          value: Number(r.value ?? 0),
        })),
      };
    }

    // --- groupBy (JSONPath) ---
    if (params.groupBy) {
      const groupPath = validateJsonPath(params.groupBy);
      const groupSourceCol = params.from === "input" ? "input" : "output";
      const groupChKeys = jsonPathToChKeys(groupPath);
      const groupExpr = `JSONExtractString(${groupSourceCol}, ${groupChKeys})`;
      const sql = `SELECT ${groupExpr} AS group_key, ${aggExpr} AS value FROM ${this.source} WHERE ${whereClause} AND ${groupExpr} != '' GROUP BY ${groupExpr} ORDER BY value DESC LIMIT ${rowLimit}`;
      const rows = await this.engine.query(sql);
      return {
        value: null,
        groups: rows.map((r) => ({
          key: String(r.group_key ?? ""),
          value: Number(r.value ?? 0),
        })),
      };
    }

    // --- interval (timeseries) ---
    if (params.interval) {
      const bucketExpr = intervalToSQL(params.interval);
      const sql = `SELECT ${bucketExpr} AS bucket, ${aggExpr} AS value FROM ${this.source} WHERE ${whereClause} GROUP BY bucket ORDER BY bucket ASC LIMIT ${rowLimit}`;
      const rows = await this.engine.query(sql);
      return {
        value: null,
        timeseries: rows.map((r) => ({
          timestamp: String(r.bucket ?? ""),
          value: Number(r.value ?? 0),
        })),
      };
    }

    // --- simple aggregation ---
    const sql = `SELECT ${aggExpr} AS value FROM ${this.source} WHERE ${whereClause}`;
    const rows = await this.engine.query(sql);
    return {
      value: Number(rows[0]?.value ?? 0),
    };
  }

  async countMatched(params: {
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
  }): Promise<number> {
    if (!params.organizationId) {
      throw new Error("organizationId is required");
    }

    const jsonPath = validateJsonPath(params.path);
    const sourceCol = params.from === "input" ? "input" : "output";
    const chKeys = jsonPathToChKeys(jsonPath);

    const where: string[] = [
      `organization_id = '${esc(params.organizationId)}'`,
      `JSONExtractString(${sourceCol}, ${chKeys}) IS NOT NULL`,
      `JSONExtractString(${sourceCol}, ${chKeys}) != ''`,
    ];

    where.push(...buildCommonFilterClauses(params.filters));

    const sql = `SELECT count(*) AS cnt FROM ${this.source} WHERE ${where.join(" AND ")}`;
    const rows = await this.engine.query(sql);
    return Number(rows[0]?.cnt ?? 0);
  }
  async queryMetricTimeseries(params: {
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
  }> {
    const emptyResult = {
      totalCalls: 0,
      totalErrors: 0,
      avgDurationMs: 0,
      p50DurationMs: 0,
      p95DurationMs: 0,
      connectionBreakdown: [],
      timeseries: [],
    };

    try {
      if (!params.organizationId) {
        throw new Error("organizationId is required");
      }

      const bucketExpr = intervalToSQL(params.interval);

      const where: string[] = [
        `organization_id = '${esc(params.organizationId)}'`,
      ];

      if (params.startDate) {
        where.push(tsGte(params.startDate));
      }
      if (params.endDate) {
        where.push(tsLte(params.endDate));
      }
      if (params.filters?.toolNames?.length) {
        const names = params.filters.toolNames
          .slice(0, 100)
          .map((n) => `'${esc(n)}'`)
          .join(",");
        where.push(`tool_name IN (${names})`);
      }
      if (params.filters?.connectionIds?.length) {
        const ids = params.filters.connectionIds
          .slice(0, 100)
          .map((id) => `'${esc(id)}'`)
          .join(",");
        where.push(`connection_id IN (${ids})`);
      }
      if (params.filters?.excludeConnectionIds?.length) {
        const ids = params.filters.excludeConnectionIds
          .slice(0, 100)
          .map((id) => `'${esc(id)}'`)
          .join(",");
        where.push(`connection_id NOT IN (${ids})`);
      }
      if (params.filters?.status) {
        where.push(`status = '${esc(params.filters.status)}'`);
      }

      const whereClause = where.join(" AND ");

      const sql = `SELECT
  ${bucketExpr} AS bucket,
  sumIf(value, name = 'tool.execution.count') AS calls,
  sumIf(value, name = 'tool.execution.count' AND status = 'error') AS errors,
  sumIf(hist_sum, name = 'tool.execution.duration') AS total_hist_sum,
  sumIf(hist_count, name = 'tool.execution.duration') AS total_hist_count,
  groupArrayIf(hist_boundaries, name = 'tool.execution.duration') AS boundaries_arr,
  groupArrayIf(hist_bucket_counts, name = 'tool.execution.duration') AS bucket_counts_arr
FROM ${this.metricSource}
WHERE ${whereClause}
GROUP BY bucket
ORDER BY bucket ASC`;

      const rows = await this.metricEngine.query(sql);

      const breakdownSql = `SELECT
  connection_id,
  sumIf(value, name = 'tool.execution.count') AS calls,
  sumIf(value, name = 'tool.execution.count' AND status = 'error') AS errors,
  sumIf(hist_sum, name = 'tool.execution.duration') AS total_hist_sum,
  sumIf(hist_count, name = 'tool.execution.duration') AS total_hist_count
FROM ${this.metricSource}
WHERE ${whereClause} AND connection_id != ''
GROUP BY connection_id
ORDER BY calls DESC
LIMIT 1000`;

      const connectionBreakdownRows =
        await this.metricEngine.query(breakdownSql);

      if (rows.length === 0) {
        return {
          ...emptyResult,
          connectionBreakdown: connectionBreakdownRows.map((row) => {
            const calls = Number(row.calls ?? 0);
            const errors = Number(row.errors ?? 0);
            const totalHistSum = Number(row.total_hist_sum ?? 0);
            const totalHistCount = Number(row.total_hist_count ?? 0);

            return {
              connectionId: String(row.connection_id ?? ""),
              calls,
              errors,
              errorRate: calls > 0 ? (errors / calls) * 100 : 0,
              avgDurationMs:
                totalHistCount > 0 ? totalHistSum / totalHistCount : 0,
            };
          }),
        };
      }

      // Accumulate totals across all buckets
      let totalCalls = 0;
      let totalErrors = 0;
      let totalHistSum = 0;
      let totalHistCount = 0;
      const allBoundaries: number[][] = [];
      const allBucketCounts: number[][] = [];

      const timeseries = rows.map((row) => {
        const calls = Number(row.calls ?? 0);
        const errors = Number(row.errors ?? 0);
        const histSum = Number(row.total_hist_sum ?? 0);
        const histCount = Number(row.total_hist_count ?? 0);
        const avg = histCount > 0 ? histSum / histCount : 0;
        const errorRate = calls > 0 ? errors / calls : 0;

        totalCalls += calls;
        totalErrors += errors;
        totalHistSum += histSum;
        totalHistCount += histCount;

        // Parse histogram arrays for percentile computation
        const boundariesArr = parseGroupedArrays(row.boundaries_arr);
        const bucketCountsArr = parseGroupedArrays(row.bucket_counts_arr);

        // Merge all histogram data in this time bucket
        const { boundaries: mergedBounds, counts: mergedCounts } =
          mergeHistogramBuckets(boundariesArr, bucketCountsArr);

        // Accumulate for global percentiles
        if (mergedBounds.length > 0) {
          allBoundaries.push(mergedBounds);
          allBucketCounts.push(mergedCounts);
        }

        const p50 = computePercentileFromHistogramBuckets(
          mergedBounds,
          mergedCounts,
          0.5,
        );
        const p95 = computePercentileFromHistogramBuckets(
          mergedBounds,
          mergedCounts,
          0.95,
        );

        return {
          timestamp: String(row.bucket ?? ""),
          calls,
          errors,
          errorRate,
          avg,
          p50,
          p95,
        };
      });

      // Global percentiles from merged histogram data
      const { boundaries: globalBounds, counts: globalCounts } =
        mergeHistogramBuckets(allBoundaries, allBucketCounts);

      return {
        totalCalls,
        totalErrors,
        avgDurationMs: totalHistCount > 0 ? totalHistSum / totalHistCount : 0,
        p50DurationMs: computePercentileFromHistogramBuckets(
          globalBounds,
          globalCounts,
          0.5,
        ),
        p95DurationMs: computePercentileFromHistogramBuckets(
          globalBounds,
          globalCounts,
          0.95,
        ),
        connectionBreakdown: connectionBreakdownRows.map((row) => {
          const calls = Number(row.calls ?? 0);
          const errors = Number(row.errors ?? 0);
          const totalHistSum = Number(row.total_hist_sum ?? 0);
          const totalHistCount = Number(row.total_hist_count ?? 0);

          return {
            connectionId: String(row.connection_id ?? ""),
            calls,
            errors,
            errorRate: calls > 0 ? (errors / calls) * 100 : 0,
            avgDurationMs:
              totalHistCount > 0 ? totalHistSum / totalHistCount : 0,
          };
        }),
        timeseries,
      };
    } catch (err) {
      console.error("queryMetricTimeseries failed:", err);
      return emptyResult;
    }
  }

  async queryMetricTopToolsTimeseries(params: {
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
  }> {
    const emptyResult = {
      topTools: [],
      timeseries: [],
    };

    try {
      if (!params.organizationId) {
        throw new Error("organizationId is required");
      }

      const bucketExpr = intervalToSQL(params.interval);
      const where: string[] = [
        `organization_id = '${esc(params.organizationId)}'`,
      ];

      if (params.startDate) {
        where.push(tsGte(params.startDate));
      }
      if (params.endDate) {
        where.push(tsLte(params.endDate));
      }
      if (params.filters?.toolNames?.length) {
        const names = params.filters.toolNames
          .slice(0, 100)
          .map((n) => `'${esc(n)}'`)
          .join(",");
        where.push(`tool_name IN (${names})`);
      }
      if (params.filters?.connectionIds?.length) {
        const ids = params.filters.connectionIds
          .slice(0, 100)
          .map((id) => `'${esc(id)}'`)
          .join(",");
        where.push(`connection_id IN (${ids})`);
      }
      if (params.filters?.excludeConnectionIds?.length) {
        const ids = params.filters.excludeConnectionIds
          .slice(0, 100)
          .map((id) => `'${esc(id)}'`)
          .join(",");
        where.push(`connection_id NOT IN (${ids})`);
      }
      if (params.filters?.status) {
        where.push(`status = '${esc(params.filters.status)}'`);
      }

      const whereClause = where.join(" AND ");
      const topN = Math.min(Math.max(1, Math.floor(params.topN ?? 10)), 20);

      const topToolsSql = `SELECT
  tool_name,
  argMax(connection_id, connection_calls) AS connection_id,
  sum(connection_calls) AS calls
FROM (
  SELECT
    tool_name,
    connection_id,
    sumIf(value, name = 'tool.execution.count') AS connection_calls
  FROM ${this.metricSource}
  WHERE ${whereClause} AND tool_name != ''
  GROUP BY tool_name, connection_id
)
GROUP BY tool_name
ORDER BY calls DESC
LIMIT ${topN}`;

      const topToolRows = await this.metricEngine.query(topToolsSql);

      if (topToolRows.length === 0) {
        return emptyResult;
      }

      const topToolNames = topToolRows
        .map((row) => String(row.tool_name ?? ""))
        .filter(Boolean);
      const toolNamesSql = topToolNames
        .map((name) => `'${esc(name)}'`)
        .join(",");

      const timeseriesSql = `SELECT
  ${bucketExpr} AS bucket,
  tool_name,
  sumIf(value, name = 'tool.execution.count') AS calls,
  sumIf(value, name = 'tool.execution.count' AND status = 'error') AS errors,
  sumIf(hist_sum, name = 'tool.execution.duration') AS total_hist_sum,
  sumIf(hist_count, name = 'tool.execution.duration') AS total_hist_count,
  groupArrayIf(hist_boundaries, name = 'tool.execution.duration') AS boundaries_arr,
  groupArrayIf(hist_bucket_counts, name = 'tool.execution.duration') AS bucket_counts_arr
FROM ${this.metricSource}
WHERE ${whereClause} AND tool_name IN (${toolNamesSql})
GROUP BY bucket, tool_name
ORDER BY bucket ASC, tool_name ASC`;

      const rows = await this.metricEngine.query(timeseriesSql);

      return {
        topTools: topToolRows.map((row) => ({
          toolName: String(row.tool_name ?? ""),
          connectionId:
            row.connection_id != null ? String(row.connection_id) : null,
          calls: Number(row.calls ?? 0),
        })),
        timeseries: rows.map((row) => {
          const calls = Number(row.calls ?? 0);
          const errors = Number(row.errors ?? 0);
          const histSum = Number(row.total_hist_sum ?? 0);
          const histCount = Number(row.total_hist_count ?? 0);
          const boundariesArr = parseGroupedArrays(row.boundaries_arr);
          const bucketCountsArr = parseGroupedArrays(row.bucket_counts_arr);
          const { boundaries, counts } = mergeHistogramBuckets(
            boundariesArr,
            bucketCountsArr,
          );

          return {
            timestamp: String(row.bucket ?? ""),
            toolName: String(row.tool_name ?? ""),
            calls,
            errors,
            avg: histCount > 0 ? histSum / histCount : 0,
            p95: computePercentileFromHistogramBuckets(
              boundaries,
              counts,
              0.95,
            ),
          };
        }),
      };
    } catch (err) {
      console.error("queryMetricTopToolsTimeseries failed:", err);
      return emptyResult;
    }
  }
}

// ---------------------------------------------------------------------------
// Histogram helpers
// ---------------------------------------------------------------------------

/**
 * Parse grouped array results from ClickHouse.
 * groupArrayIf returns an array of JSON strings (each being a serialized array).
 */
export function parseGroupedArrays(val: unknown): number[][] {
  if (!val) return [];
  if (Array.isArray(val)) {
    return val.map((item) => {
      if (typeof item === "string") {
        try {
          return JSON.parse(item) as number[];
        } catch {
          return [];
        }
      }
      if (Array.isArray(item)) return item as number[];
      return [];
    });
  }
  if (typeof val === "string") {
    try {
      const parsed = JSON.parse(val);
      if (Array.isArray(parsed)) {
        return parsed.map((item: unknown) => {
          if (typeof item === "string") {
            try {
              return JSON.parse(item) as number[];
            } catch {
              return [];
            }
          }
          if (Array.isArray(item)) return item as number[];
          return [];
        });
      }
    } catch {
      return [];
    }
  }
  return [];
}

/**
 * Merge multiple histogram bucket arrays into one.
 * All histograms must share the same boundaries (OTel SDK uses consistent boundaries).
 * Bucket counts are additive (delta temporality).
 */
export function mergeHistogramBuckets(
  boundariesArrays: number[][],
  countsArrays: number[][],
): { boundaries: number[]; counts: number[] } {
  if (boundariesArrays.length === 0 || countsArrays.length === 0) {
    return { boundaries: [], counts: [] };
  }

  // Use the first non-empty boundaries as reference
  let refBoundaries: number[] = [];
  for (const b of boundariesArrays) {
    if (b.length > 0) {
      refBoundaries = b;
      break;
    }
  }

  if (refBoundaries.length === 0) {
    return { boundaries: [], counts: [] };
  }

  // Expected bucket count = boundaries + 1 (one bucket per boundary gap, plus overflow)
  const expectedBuckets = refBoundaries.length + 1;
  const mergedCounts = new Array<number>(expectedBuckets).fill(0);

  for (const counts of countsArrays) {
    if (counts.length === 0) continue;
    const len = Math.min(counts.length, expectedBuckets);
    for (let i = 0; i < len; i++) {
      mergedCounts[i]! += counts[i]!;
    }
  }

  return { boundaries: refBoundaries, counts: mergedCounts };
}

/**
 * Compute a percentile from histogram bucket boundaries and counts
 * using linear interpolation.
 *
 * @param boundaries - Sorted upper boundaries of histogram buckets (N values)
 * @param counts - Counts for each bucket (N+1 values: one per boundary gap + overflow)
 * @param p - Percentile to compute (0-1, e.g. 0.5 for p50)
 */
export function computePercentileFromHistogramBuckets(
  boundaries: number[],
  counts: number[],
  p: number,
): number {
  if (boundaries.length === 0 || counts.length === 0) return 0;

  const totalCount = counts.reduce((a, b) => a + b, 0);
  if (totalCount === 0) return 0;

  const targetCount = p * totalCount;
  let cumulativeCount = 0;

  // Buckets: (-inf, b[0]], (b[0], b[1]], ..., (b[n-1], +inf)
  for (let i = 0; i < counts.length; i++) {
    const prevCumulative = cumulativeCount;
    const bucketCount = counts[i] ?? 0;
    cumulativeCount += bucketCount;

    if (cumulativeCount >= targetCount) {
      // The percentile falls in this bucket
      const bucketLower = i === 0 ? 0 : (boundaries[i - 1] ?? 0);
      const bucketUpper =
        i < boundaries.length
          ? (boundaries[i] ?? 0)
          : (boundaries[boundaries.length - 1] ?? 0) * 2;

      // Linear interpolation within the bucket
      const bucketFraction =
        bucketCount > 0 ? (targetCount - prevCumulative) / bucketCount : 0;
      return bucketLower + bucketFraction * (bucketUpper - bucketLower);
    }
  }

  // Fallback: return the last boundary
  return boundaries[boundaries.length - 1] ?? 0;
}

// ---------------------------------------------------------------------------
// Aggregation expression builder
// ---------------------------------------------------------------------------

function buildAggExpr(fn: string, valueExpr: string): string {
  switch (fn) {
    case "sum":
      return `coalesce(sum(${valueExpr}), 0)`;
    case "avg":
      return `coalesce(avg(${valueExpr}), 0)`;
    case "min":
      return `min(${valueExpr})`;
    case "max":
      return `max(${valueExpr})`;
    case "count":
      return `count(*)`;
    case "count_all":
      return `count(*)`;
    case "last":
      return `argMax(${valueExpr}, timestamp)`;
    default:
      throw new Error(`Unknown aggregation function: ${fn}`);
  }
}
