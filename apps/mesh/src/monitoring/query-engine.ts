/**
 * QueryEngine abstraction for monitoring queries.
 *
 * Implementations:
 * - ChdbEngine: local dev, uses chdb (embedded ClickHouse)
 * - ClickHouseClientEngine: production, uses @clickhouse/client over HTTP
 */

import { createClient, type ClickHouseClient } from "@clickhouse/client";
import { resolve } from "node:path";
import { DEFAULT_MONITORING_URI } from "./schema";

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
 */
export class ClickHouseClientEngine implements QueryEngine {
  private client: ClickHouseClient;

  constructor(url: string) {
    this.client = createClient({ url });
  }

  async query(
    sql: string,
    params?: Record<string, unknown>,
  ): Promise<Record<string, unknown>[]> {
    const result = await this.client.query({
      query: sql,
      query_params: params,
      format: "JSONEachRow",
    });
    return await result.json<Record<string, unknown>>();
  }

  async destroy(): Promise<void> {
    await this.client.close();
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
  async query(): Promise<Record<string, unknown>[]> {
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

  const basePath = config.basePath ?? DEFAULT_MONITORING_URI;
  const resolvedPath = resolve(basePath);
  if (/[';]/.test(resolvedPath)) {
    throw new Error(`Invalid monitoring data path: ${resolvedPath}`);
  }

  try {
    return {
      engine: new ChdbEngine(),
      source: `file('${resolvedPath}/**/*.ndjson', 'JSONEachRow')`,
    };
  } catch {
    console.warn(
      "chdb not available — monitoring queries will return empty results",
    );
    return {
      engine: new NoopEngine(),
      source: `file('${resolvedPath}/**/*.ndjson', 'JSONEachRow')`,
    };
  }
}
