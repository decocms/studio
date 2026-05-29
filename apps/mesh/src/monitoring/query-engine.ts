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
 * DuckDB engine for local dev monitoring queries.
 * Uses embedded DuckDB to query NDJSON files from disk.
 */
export class DuckDBEngine implements QueryEngine {
  private connectionPromise: Promise<
    import("@duckdb/node-api").DuckDBConnection
  >;

  constructor() {
    this.connectionPromise = import("@duckdb/node-api").then(
      async ({ DuckDBInstance }) => {
        const { cpus } = await import("node:os");
        const threads = String(Math.max(1, cpus().length));
        const instance = await DuckDBInstance.create("", { threads });
        return instance.connect();
      },
    );
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

/**
 * Config for the ClickHouse Cloud Query API engine. Authenticates with an
 * OpenAPI key (key id + secret over HTTP Basic) instead of a database
 * user/password embedded in a connection URL.
 */
export interface ClickHouseQueryApiConfig {
  serviceId: string;
  keyId: string;
  keySecret: string;
  maxMemoryUsage?: string;
  maxExecutionTime?: number;
}

/**
 * Build a ClickHouseQueryApiConfig from settings, or undefined when the
 * three required values are not all present. Used by callers to decide
 * whether to opt into the Query API path over the url-based engine.
 */
export function resolveClickHouseQueryApiConfig(settings: {
  clickhouseServiceId?: string;
  clickhouseKeyId?: string;
  clickhouseKeySecret?: string;
}): ClickHouseQueryApiConfig | undefined {
  const { clickhouseServiceId, clickhouseKeyId, clickhouseKeySecret } =
    settings;
  if (clickhouseServiceId && clickhouseKeyId && clickhouseKeySecret) {
    return {
      serviceId: clickhouseServiceId,
      keyId: clickhouseKeyId,
      keySecret: clickhouseKeySecret,
    };
  }
  return undefined;
}

/**
 * Execute one SQL statement against the ClickHouse Cloud query gateway and
 * return parsed JSONEachRow rows. Shared by ClickHouseQueryApiEngine (read
 * SELECTs) and the rollup DDL path (CREATE TABLE / MATERIALIZED VIEW).
 */
export async function runClickHouseQueryApi(
  config: ClickHouseQueryApiConfig,
  sql: string,
): Promise<Record<string, unknown>[]> {
  const auth = Buffer.from(`${config.keyId}:${config.keySecret}`).toString(
    "base64",
  );
  const response = await fetch(
    `https://queries.clickhouse.cloud/service/${config.serviceId}/run?format=JSONEachRow`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Basic ${auth}`,
      },
      body: JSON.stringify({ sql }),
    },
  );
  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(
      `ClickHouse Query API failed: ${response.status} ${response.statusText} - ${errorText.slice(0, 500)}`,
    );
  }
  const text = await response.text();
  if (!text.trim()) return [];
  const rows: Record<string, unknown>[] = [];
  for (const line of text.trim().split("\n")) {
    if (!line.trim()) continue;
    try {
      rows.push(JSON.parse(line));
    } catch {
      console.error(
        `[clickhouse-query-api] skipped malformed row: ${line.slice(0, 100)}...`,
      );
    }
  }
  return rows;
}

/**
 * ClickHouse Cloud Query API engine for production monitoring queries.
 * Runs SQL over `queries.clickhouse.cloud/service/{id}/run` with an OpenAPI
 * key. Opt-in alternative to ClickHouseClientEngine, which stays the default
 * so existing url-based deployments are unaffected.
 */
export class ClickHouseQueryApiEngine implements QueryEngine {
  private maxMemoryUsage: string;
  private maxExecutionTime: number;

  constructor(private config: ClickHouseQueryApiConfig) {
    this.maxMemoryUsage = config.maxMemoryUsage ?? "200000000";
    this.maxExecutionTime = config.maxExecutionTime ?? 30;
  }

  async query(sql: string): Promise<Record<string, unknown>[]> {
    return runClickHouseQueryApi(this.config, this.withSettings(sql));
  }

  // Preserve the memory/time guardrails ClickHouseClientEngine sets via
  // clickhouse_settings. The gateway takes raw SQL, so the limits are
  // appended as a SETTINGS clause; skipped if the SQL already declares one.
  private withSettings(sql: string): string {
    if (/\bsettings\b/i.test(sql)) return sql;
    const half = Math.floor(Number(this.maxMemoryUsage) / 2);
    return `${sql}\nSETTINGS max_memory_usage=${this.maxMemoryUsage}, max_execution_time=${this.maxExecutionTime}, max_bytes_before_external_group_by=${half}, max_bytes_before_external_sort=${half}`;
  }
}

const DEFAULT_TABLE_NAME = "monitoring_logs";

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
