/**
 * QueryEngine abstraction for monitoring queries.
 *
 * Implementations:
 * - ChdbEngine: local dev, uses chdb (embedded ClickHouse)
 * - ClickHouseClientEngine: production, uses @clickhouse/client over HTTP
 */

import { createClient, type ClickHouseClient } from "@clickhouse/client";
import { DEFAULT_MONITORING_DATA_PATH } from "./schema";

export interface QueryEngine {
  query(sql: string): Promise<Record<string, unknown>[]>;
  destroy?(): void | Promise<void>;
}

/**
 * chdb engine for local dev monitoring queries.
 * Uses embedded ClickHouse to query NDJSON files from disk.
 */
export class ChdbEngine implements QueryEngine {
  async query(sql: string): Promise<Record<string, unknown>[]> {
    const chdb = require("chdb");
    const result: string = chdb.query(sql, "JSONEachRow");
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

  async query(sql: string): Promise<Record<string, unknown>[]> {
    const result = await this.client.query({
      query: sql,
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

  const basePath = config.basePath ?? DEFAULT_MONITORING_DATA_PATH;
  return {
    engine: new ChdbEngine(),
    source: `file('${basePath}/**/*.ndjson', 'JSONEachRow')`,
  };
}
