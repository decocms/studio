/**
 * QueryEngine abstraction for monitoring queries.
 *
 * Implementations:
 * - ChdbEngine: local dev, uses chdb (embedded ClickHouse)
 * - ClickHouseClientEngine: production, uses @clickhouse/client over HTTP
 */

import { resolve } from "node:path";
import { DEFAULT_LOGS_DIR } from "./schema";

export interface QueryEngine {
  query(
    sql: string,
    params?: Record<string, unknown>,
  ): Promise<Record<string, unknown>[]>;
  destroy?(): void | Promise<void>;
}

/**
 * chdb engine for local dev monitoring queries.
 * Uses embedded ClickHouse to query NDJSON files from disk.
 */
export class ChdbEngine implements QueryEngine {
  private chdb: { query: (sql: string, format: string) => string };

  constructor() {
    try {
      this.chdb = require("chdb");
    } catch (e) {
      throw new Error(
        "chdb native module not available. Install with: bun add chdb",
        { cause: e },
      );
    }
  }

  async query(sql: string): Promise<Record<string, unknown>[]> {
    const result: string = this.chdb.query(sql, "JSONEachRow");
    if (!result || !result.trim()) return [];

    return result
      .trim()
      .split("\n")
      .map((line: string) => JSON.parse(line));
  }

  async destroy(): Promise<void> {
    // chdb is stateless per query — nothing to clean up
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

  constructor(url: string) {
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
    });
    return await result.json<Record<string, unknown>>();
  }

  async destroy(): Promise<void> {
    await this.initPromise;
    const client = this.client as import("@clickhouse/client").ClickHouseClient;
    await client.close();
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
 * - Otherwise: ChdbEngine querying local NDJSON files
 *
 * Returns { engine, source } where source is the FROM clause expression.
 */
/**
 * No-op engine returned when chdb is unavailable (e.g. CI, environments
 * without the native module). Monitoring queries return empty results.
 */
class NoopEngine implements QueryEngine {
  private warned = false;

  async query(): Promise<Record<string, unknown>[]> {
    if (!this.warned) {
      this.warned = true;
      console.warn(
        "\n⚠️  WARNING: Monitoring query skipped — chdb native module is not available.\n" +
          "   Monitoring data exists on disk but cannot be queried.\n" +
          "   Fix: run `bun add chdb` in apps/mesh/ to install the native module.\n",
      );
    }
    return [];
  }
}

export function createMonitoringEngine(config: MonitoringEngineConfig): {
  engine: QueryEngine;
  source: string;
} {
  if (config.clickhouseUrl) {
    return {
      engine: new ClickHouseClientEngine(config.clickhouseUrl),
      source: config.tableName ?? DEFAULT_TABLE_NAME,
    };
  }

  const basePath = config.basePath ?? DEFAULT_LOGS_DIR;
  const resolvedPath = resolve(basePath);
  if (/[';]/.test(resolvedPath)) {
    throw new Error(`Invalid monitoring data path: ${resolvedPath}`);
  }

  try {
    return {
      engine: new ChdbEngine(),
      source: `file('${resolvedPath}/**/*.ndjson', 'JSONEachRow')`,
    };
  } catch (err) {
    console.warn(
      "\n⚠️  WARNING: chdb native module failed to load — monitoring will return empty results.\n" +
        `   Error: ${err instanceof Error ? err.message : err}\n` +
        "   Fix: run `bun add chdb` in apps/mesh/ to reinstall the native module.\n",
    );
    return {
      engine: new NoopEngine(),
      source: `file('${resolvedPath}/**/*.ndjson', 'JSONEachRow')`,
    };
  }
}
