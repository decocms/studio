/**
 * QueryEngine abstraction for monitoring queries.
 *
 * Implementations:
 * - DuckDBEngine: local dev, uses @duckdb/node-api (embedded DuckDB)
 * - ClickHouseClientEngine: production, uses @clickhouse/client over HTTP
 */

import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { getLogsDir } from "./schema";

export interface QueryEngine {
  query(
    sql: string,
    params?: Record<string, unknown>,
  ): Promise<Record<string, unknown>[]>;
  destroy?(): void | Promise<void>;
}

/**
 * Time window used to prune which storage partitions a query reads. Passed
 * through the source factory so the GCS OTLP path can scope the bucket glob to
 * the relevant Hive day partitions (see buildHivePartitionFilter). Other paths
 * (ClickHouse, local NDJSON) ignore it.
 */
export interface MonitoringDateRange {
  startDate?: Date;
  endDate?: Date;
}

/**
 * Credentials + extension dir for reading object storage (GCS via its
 * S3-compatible endpoint) through DuckDB's httpfs extension. When supplied to
 * DuckDBEngine, the connection is primed once with `LOAD httpfs` + a `CREATE
 * SECRET` so `read_json('s3://…')` works against the bucket.
 */
export interface DuckDBGcsConfig {
  /**
   * Object-storage endpoint. May include a scheme (e.g.
   * "https://storage.googleapis.com" or "http://localhost:9000") — it is
   * normalized to a bare host for DuckDB's `ENDPOINT`, and the scheme (if any)
   * determines `USE_SSL`. A scheme-less value defaults to SSL.
   */
  endpoint: string;
  /** "auto" or a concrete region. */
  region: string;
  /** GCS HMAC access key. */
  accessKeyId: string;
  /** GCS HMAC secret. */
  secretAccessKey: string;
  /** Absolute path to the extension dir holding the pre-installed httpfs. */
  extensionDirectory: string;
}

/**
 * Memory tuning for the embedded DuckDB engine. The OTLP-flatten query reads
 * the whole bucket prefix (no time pruning) and `unnest`s nested arrays into a
 * `map_from_entries` per row, which is memory-heavy. On a small container the
 * default 80%-of-RAM limit is easily blown, so we (a) enable an on-disk
 * `temp_directory` — an in-memory DuckDB has none and therefore CANNOT spill,
 * turning any over-limit operator into a hard OOM instead of a slow query — and
 * (b) disable `preserve_insertion_order` so large results aren't buffered whole.
 */
export interface DuckDBTuning {
  /** DuckDB `memory_limit` (e.g. "2GB"). Unset → DuckDB's default (80% RAM). */
  memoryLimit?: string;
  /** DuckDB `threads`. Unset → all CPUs. Fewer threads → lower peak memory. */
  threads?: number;
  /** Spill directory. Unset → a subdir of the OS temp dir. */
  tempDirectory?: string;
}

/** Escape a value for a single-quoted DuckDB SQL literal. */
function escSqlLiteral(value: string): string {
  return value.replace(/'/g, "''");
}

/**
 * Normalize an object-storage endpoint for a DuckDB s3 secret. DuckDB's
 * `ENDPOINT` is the bare host (no scheme) and the scheme is carried by
 * `USE_SSL`; passing a scheme-prefixed endpoint yields a broken read URL
 * (e.g. `https://https://...`). Strips the scheme to derive the host and
 * `useSsl` (https → true, http → false, scheme-less → true).
 */
export function normalizeS3Endpoint(raw: string): {
  host: string;
  useSsl: boolean;
} {
  const trimmed = raw.trim();
  const match = /^(https?):\/\//i.exec(trimmed);
  const useSsl = match ? match[1]!.toLowerCase() === "https" : true;
  const host = trimmed.replace(/^https?:\/\//i, "").replace(/\/+$/, "");
  return { host, useSsl };
}

/**
 * DuckDB engine for embedded monitoring queries.
 * Reads NDJSON files from local disk, or — when `gcs` is supplied — OTLP-JSON
 * files from object storage via httpfs.
 */
export class DuckDBEngine implements QueryEngine {
  private connectionPromise: Promise<
    import("@duckdb/node-api").DuckDBConnection
  >;

  constructor(gcs?: DuckDBGcsConfig, tuning?: DuckDBTuning) {
    this.connectionPromise = import("@duckdb/node-api").then(
      async ({ DuckDBInstance }) => {
        const { cpus } = await import("node:os");
        const threads = String(Math.max(1, tuning?.threads ?? cpus().length));
        // An in-memory DuckDB ("") has no temp_directory and so cannot spill —
        // any operator that exceeds memory_limit throws OutOfMemory instead of
        // going out-of-core. Point it at a real dir and disable insertion-order
        // preservation so the OTLP-flatten query streams instead of buffering.
        const config: Record<string, string> = {
          threads,
          temp_directory: tuning?.tempDirectory ?? `${tmpdir()}/duckdb-spill`,
          preserve_insertion_order: "false",
        };
        if (tuning?.memoryLimit) config.memory_limit = tuning.memoryLimit;
        const instance = await DuckDBInstance.create("", config);
        const connection = await instance.connect();
        if (gcs) {
          await DuckDBEngine.setupGcs(connection, gcs);
        }
        return connection;
      },
    );
  }

  /**
   * Prime a connection to read from GCS: load the pre-baked httpfs extension
   * (no runtime download) and register an s3-type secret pointed at the GCS
   * S3-compatible endpoint.
   */
  private static async setupGcs(
    connection: import("@duckdb/node-api").DuckDBConnection,
    gcs: DuckDBGcsConfig,
  ): Promise<void> {
    // httpfs is baked into the image at build time; never reach out to the
    // DuckDB extension CDN at runtime (strict-outbound self-hosters).
    await connection.run(
      [
        `SET extension_directory='${escSqlLiteral(gcs.extensionDirectory)}';`,
        `SET autoinstall_known_extensions=false;`,
        `SET autoload_known_extensions=false;`,
        `LOAD httpfs;`,
      ].join("\n"),
    );

    // DuckDB's ENDPOINT is a bare host; the scheme is carried by USE_SSL.
    const { host, useSsl } = normalizeS3Endpoint(gcs.endpoint);
    const secretSql = `CREATE OR REPLACE SECRET studio_gcs (
  TYPE s3,
  PROVIDER config,
  KEY_ID '${escSqlLiteral(gcs.accessKeyId)}',
  SECRET '${escSqlLiteral(gcs.secretAccessKey)}',
  REGION '${escSqlLiteral(gcs.region)}',
  ENDPOINT '${escSqlLiteral(host)}',
  URL_STYLE 'path',
  USE_SSL ${useSsl}
);`;
    try {
      await connection.run(secretSql);
    } catch {
      // Never surface the SECRET DDL — it carries the HMAC secret.
      throw new Error("Failed to initialize DuckDB GCS secret");
    }
  }

  async query(sql: string): Promise<Record<string, unknown>[]> {
    const connection = await this.connectionPromise;
    try {
      const reader = await connection.runAndReadAll(sql);
      if (reader.currentRowCount === 0) return [];
      return reader.getRowObjectsJS();
    } catch (err: unknown) {
      // DuckDB throws when no files match the glob pattern
      if (
        err instanceof Error &&
        err.message.includes("No files found that match the pattern")
      ) {
        return [];
      }
      throw err;
    }
  }

  async destroy(): Promise<void> {
    const connection = await this.connectionPromise;
    connection.disconnectSync();
  }
}

/**
 * ClickHouse client engine for production monitoring queries.
 * Uses @clickhouse/client to query a remote ClickHouse instance over HTTP.
 * The import is dynamic to avoid loading the package when not needed.
 */
export class ClickHouseClientEngine implements QueryEngine {
  private client: unknown;
  private initPromise: Promise<void>;
  private maxMemoryUsage: string;
  private maxExecutionTime: number;

  constructor(
    url: string,
    options?: { maxMemoryUsage?: string; maxExecutionTime?: number },
  ) {
    // 4 GiB. The monitoring view reads the entire `LogAttributes` map per row
    // (incl. input/output blobs), so a tight cap OOMs on busy orgs. Override
    // via CLICKHOUSE_MAX_MEMORY_USAGE on a memory-constrained ClickHouse.
    this.maxMemoryUsage = options?.maxMemoryUsage ?? "4294967296";
    this.maxExecutionTime = options?.maxExecutionTime ?? 30;
    this.initPromise = import("@clickhouse/client").then(({ createClient }) => {
      this.client = createClient({ url });
    });
  }

  async query(
    sql: string,
    params?: Record<string, unknown>,
  ): Promise<Record<string, unknown>[]> {
    await this.initPromise;
    const client = this.client as import("@clickhouse/client").ClickHouseClient;
    const result = await client.query({
      query: sql,
      query_params: params,
      format: "JSONEachRow",
      clickhouse_settings: {
        max_memory_usage: this.maxMemoryUsage,
        max_execution_time: this.maxExecutionTime,
        max_bytes_before_external_group_by: String(
          Math.floor(Number(this.maxMemoryUsage) / 2),
        ),
        max_bytes_before_external_sort: String(
          Math.floor(Number(this.maxMemoryUsage) / 2),
        ),
        max_threads: 1,
      },
    });
    return await result.json<Record<string, unknown>>();
  }

  async destroy(): Promise<void> {
    await this.initPromise;
    const client = this.client as import("@clickhouse/client").ClickHouseClient;
    await client.close();
  }
}

const DEFAULT_TABLE_NAME = "studio_monitoring_logs";

export interface MonitoringEngineConfig {
  clickhouseUrl?: string;
  basePath?: string;
  tableName?: string;
}

/**
 * Create the appropriate QueryEngine and source expression based on config.
 *
 * - If clickhouseUrl is set: ClickHouseClientEngine querying a remote table
 * - Otherwise: DuckDBEngine querying local NDJSON files
 *
 * Returns { engine, source } where source is the FROM clause expression.
 */
export async function createMonitoringEngine(
  config: MonitoringEngineConfig,
): Promise<{
  engine: QueryEngine;
  source: string;
}> {
  if (config.clickhouseUrl) {
    return {
      engine: new ClickHouseClientEngine(config.clickhouseUrl),
      source: config.tableName ?? DEFAULT_TABLE_NAME,
    };
  }

  const basePath = config.basePath ?? getLogsDir();
  const resolvedPath = resolve(basePath);
  if (/[';]/.test(resolvedPath)) {
    throw new Error(`Invalid monitoring data path: ${resolvedPath}`);
  }

  const source = `read_ndjson('${resolvedPath}/**/*.ndjson', auto_detect=true)`;

  return { engine: new DuckDBEngine(), source };
}

/** Attribute-key prefix on Studio's monitoring OTel log records. */
const MONITORING_ATTR_PREFIX = "studio.monitoring.";

/**
 * Build a DuckDB subquery that flattens OTLP-JSON log files
 * (`ExportLogsServiceRequest`: resourceLogs[] -> scopeLogs[] -> logRecords[])
 * into the flat row shape the dashboard SQL expects. The caller scopes by org
 * via the outer `organization_id = '...'` WHERE — OTLP files are time-sharded,
 * not org-sharded, so the glob reads all orgs and the subquery only exposes the
 * column.
 *
 * Attribute values are read via `to_json(value)` + `json_extract_string` rather
 * than struct-field access: DuckDB infers the `value` struct shape from sampled
 * data, so a direct `value.intValue` reference bind-errors on files that only
 * contain `stringValue`. The JSON path returns NULL for absent fields instead.
 *
 * A date range turns on Hive partition pruning: the glob is read with
 * `hive_partitioning=true` and `opts.range` becomes a `year=/month=/day=` path
 * predicate that DuckDB pushes into file listing — so a dashboard date range
 * flattens only the relevant day partitions instead of every object in the
 * prefix (the cause of the embedded-engine OOM). This assumes the documented
 * collector layout; without a range it's a plain read of the whole glob.
 *
 * COST: pruning covers the *data* scan (the memory-heavy flatten). Schema
 * detection still lists/samples objects under the prefix, and a query filters
 * rows by the row-content `timestamp` (not the path) for sub-day precision — so
 * a bucket lifecycle/retention rule still bounds the per-query listing cost as
 * history grows (see monitoring docs).
 */
export function buildOtlpFlatSourceFromGlob(
  glob: string,
  opts?: { range?: MonitoringDateRange },
): string {
  const A = MONITORING_ATTR_PREFIX;
  const attr = (key: string) => `attrs['${A}${key}']`;
  // A range turns on Hive pruning (we assume the documented year=/month=/day=
  // layout); hive_partitioning is emitted only alongside the predicate that
  // needs those columns, so a range-less read stays a plain scan.
  const partitionFilter = buildHivePartitionFilter(opts?.range);
  const readArgs = `format='auto', union_by_name=true, maximum_object_size=33554432, ignore_errors=true${partitionFilter ? ", hive_partitioning=true" : ""}`;
  return `(
  WITH _raw AS (
    SELECT unnest(resourceLogs) AS rl
    FROM read_json('${glob}', ${readArgs})${partitionFilter ? `\n    WHERE ${partitionFilter}` : ""}
  ),
  _scopes AS (SELECT unnest(rl.scopeLogs) AS sl FROM _raw),
  _recs AS (SELECT unnest(sl.logRecords) AS lr FROM _scopes),
  _flat AS (
    SELECT
      lr.spanId AS span_id,
      lr.timeUnixNano AS ts_nano,
      map_from_entries(
        list_transform(lr.attributes, a -> struct_pack(
          k := a.key,
          v := coalesce(
            json_extract_string(to_json(a.value), '$.stringValue'),
            json_extract_string(to_json(a.value), '$.intValue'),
            json_extract_string(to_json(a.value), '$.boolValue'),
            json_extract_string(to_json(a.value), '$.doubleValue')
          )
        ))
      ) AS attrs
    FROM _recs
  )
  SELECT
    span_id AS id,
    ${attr("organization_id")} AS organization_id,
    ${attr("connection_id")} AS connection_id,
    ${attr("connection_title")} AS connection_title,
    ${attr("tool_name")} AS tool_name,
    ${attr("input")} AS input,
    ${attr("output")} AS output,
    CASE WHEN ${attr("is_error")} = 'true' THEN 1 ELSE 0 END AS is_error,
    ${attr("error_message")} AS error_message,
    TRY_CAST(${attr("duration_ms")} AS DOUBLE) AS duration_ms,
    make_timestamp(CAST(ts_nano AS BIGINT) // 1000) AS timestamp,
    ${attr("user_id")} AS user_id,
    ${attr("request_id")} AS request_id,
    ${attr("user_agent")} AS user_agent,
    ${attr("virtual_mcp_id")} AS virtual_mcp_id,
    ${attr("properties")} AS properties
  FROM _flat
  WHERE ${attr("type")} IN ('tool_call', 'llm_call')
)`;
}

/**
 * Build a Hive-partition predicate that prunes OTLP objects by their
 * `year=/month=/day=` path *before* any are read. DuckDB pushes this into file
 * listing (verified: it reports it as a "File Filter"), so a dashboard date
 * range opens only the matching day partitions instead of the whole prefix.
 *
 * Day granularity (not hour): precise second-level filtering still happens in
 * the caller's row-level WHERE on `timestamp`; this only decides which files to
 * open. The range is padded ±1 day so pruning can never drop a file holding an
 * in-range row regardless of the collector's partition timezone (max TZ skew is
 * < 24h). Partition columns are CAST explicitly because zero-padded values like
 * `month=06` are inferred as VARCHAR while `day=15` comes back BIGINT.
 *
 * Returns null when the range is open on both ends — no predicate, read all.
 */
function buildHivePartitionFilter(range?: MonitoringDateRange): string | null {
  if (!range?.startDate && !range?.endDate) return null;
  const day =
    "make_date(CAST(year AS INT), CAST(month AS INT), CAST(day AS INT))";
  const ymd = (d: Date, deltaDays: number) =>
    new Date(d.getTime() + deltaDays * 86_400_000).toISOString().slice(0, 10);
  const clauses: string[] = [];
  if (range.startDate) {
    clauses.push(`${day} >= DATE '${ymd(range.startDate, -1)}'`);
  }
  if (range.endDate) {
    clauses.push(`${day} <= DATE '${ymd(range.endDate, 1)}'`);
  }
  return clauses.join(" AND ");
}

/**
 * Build the GCS-backed OTLP flat source for a bucket/prefix. Org scoping is the
 * caller's outer WHERE (see buildOtlpFlatSourceFromGlob). A `range` prunes the
 * read to the relevant Hive day partitions.
 *
 * The glob matches every object via a recursive wildcard, not just `*.json`,
 * because the OTel `google_cloud_storage` exporter writes extensionless objects
 * (`logs_<uuid>`); `read_json(format='auto')` detects the JSON regardless.
 *
 * When pruning (a range is given), the glob is rooted at the `year=` partition
 * dir so it matches only the documented Hive layout. This both enables pruning
 * and skips legacy non-partitioned leftovers (flat objects at the prefix root,
 * or an older `key=value` scheme) — otherwise `hive_partitioning=true` errors
 * with "Hive partition mismatch" when the prefix mixes layouts. (A malformed or
 * truncated object inside a `year=` path still errors: DuckDB can't ignore parse
 * errors for single-object JSON, so rely on retention/cleanup for those.)
 */
export function buildOtlpFlatSource(opts: {
  bucket: string;
  prefix: string;
  range?: MonitoringDateRange;
}): string {
  if (/[';]/.test(opts.bucket) || /[';]/.test(opts.prefix)) {
    throw new Error("Invalid monitoring GCS bucket/prefix");
  }
  const prefix = opts.prefix.replace(/^\/+|\/+$/g, "");
  const base = prefix ? `s3://${opts.bucket}/${prefix}` : `s3://${opts.bucket}`;
  // Must match buildHivePartitionFilter's "is there a range" test so the glob
  // root and hive_partitioning stay in lockstep.
  const pruning = !!(opts.range?.startDate || opts.range?.endDate);
  const glob = pruning ? `${base}/year=*/**/*` : `${base}/**/*`;
  return buildOtlpFlatSourceFromGlob(glob, { range: opts.range });
}
