/**
 * QueryEngine abstraction for monitoring queries.
 *
 * Implementations:
 * - DuckDBEngine: local dev, uses @duckdb/node-api (embedded DuckDB)
 * - ClickHouseClientEngine: production, uses @clickhouse/client over HTTP
 */

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

  constructor(gcs?: DuckDBGcsConfig) {
    this.connectionPromise = import("@duckdb/node-api").then(
      async ({ DuckDBInstance }) => {
        const { cpus } = await import("node:os");
        const threads = String(Math.max(1, cpus().length));
        const instance = await DuckDBInstance.create("", { threads });
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
    this.maxMemoryUsage = options?.maxMemoryUsage ?? "200000000";
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
 */
export function buildOtlpFlatSourceFromGlob(glob: string): string {
  const A = MONITORING_ATTR_PREFIX;
  const attr = (key: string) => `attrs['${A}${key}']`;
  return `(
  WITH _raw AS (
    SELECT unnest(resourceLogs) AS rl
    FROM read_json('${glob}', format='auto', union_by_name=true, maximum_object_size=33554432, ignore_errors=true)
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
 * Build the GCS-backed OTLP flat source for a bucket/prefix. Org scoping is the
 * caller's outer WHERE (see buildOtlpFlatSourceFromGlob).
 *
 * The glob matches every object under the prefix (`**​/*`), not just `*.json`,
 * because the OTel `google_cloud_storage` exporter writes objects with no file
 * extension (e.g. `logs_<uuid>`). `read_json(format='auto')` detects the JSON
 * content regardless. The prefix is therefore expected to be dedicated to the
 * monitoring logs.
 */
export function buildOtlpFlatSource(opts: {
  bucket: string;
  prefix: string;
}): string {
  if (/[';]/.test(opts.bucket) || /[';]/.test(opts.prefix)) {
    throw new Error("Invalid monitoring GCS bucket/prefix");
  }
  const prefix = opts.prefix.replace(/^\/+|\/+$/g, "");
  const glob = prefix
    ? `s3://${opts.bucket}/${prefix}/**/*`
    : `s3://${opts.bucket}/**/*`;
  return buildOtlpFlatSourceFromGlob(glob);
}
