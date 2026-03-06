import { DuckDBInstance } from "@duckdb/node-api";
import type { DuckDBConnection } from "@duckdb/node-api";

/**
 * Thin async wrapper around the @duckdb/node-api driver.
 *
 * Provides promise-based query methods and manages a single
 * DuckDB instance + connection. Used by both ParquetSpanExporter
 * (write side) and DuckDBMonitoringStorage (read side).
 */
export class DuckDBProvider {
  private instancePromise: Promise<DuckDBInstance>;
  private connPromise: Promise<DuckDBConnection>;

  constructor(path: string = ":memory:") {
    this.instancePromise = DuckDBInstance.create(path);
    this.connPromise = this.instancePromise.then((inst) => inst.connect());
  }

  /**
   * Execute a query and return all rows as objects.
   */
  async all<T = Record<string, unknown>>(
    sql: string,
    ...params: unknown[]
  ): Promise<T[]> {
    const conn = await this.connPromise;

    if (params.length === 0) {
      const reader = await conn.runAndReadAll(sql);
      return reader.getRowObjects() as T[];
    }

    const prepared = await conn.prepare(sql);
    for (let i = 0; i < params.length; i++) {
      this.bindParam(prepared, i + 1, params[i]);
    }
    const reader = await prepared.runAndReadAll();
    return reader.getRowObjects() as T[];
  }

  /**
   * Execute a statement without returning rows (DDL, INSERT, etc.).
   */
  async run(sql: string, ...params: unknown[]): Promise<void> {
    const conn = await this.connPromise;

    if (params.length === 0) {
      await conn.run(sql);
      return;
    }

    const prepared = await conn.prepare(sql);
    for (let i = 0; i < params.length; i++) {
      this.bindParam(prepared, i + 1, params[i]);
    }
    await prepared.run();
  }

  /**
   * Close the database connection and instance.
   */
  async close(): Promise<void> {
    try {
      const conn = await this.connPromise;
      conn.closeSync();
    } catch {
      // Ignore close errors
    }
    try {
      const instance = await this.instancePromise;
      instance.closeSync();
    } catch {
      // Ignore close errors
    }
  }

  /**
   * Bind a parameter to a prepared statement based on its type.
   */
  private bindParam(
    prepared: Awaited<ReturnType<DuckDBConnection["prepare"]>>,
    index: number,
    value: unknown,
  ): void {
    if (value === null || value === undefined) {
      prepared.bindNull(index);
    } else if (typeof value === "number") {
      if (Number.isInteger(value)) {
        prepared.bindInteger(index, value);
      } else {
        prepared.bindDouble(index, value);
      }
    } else if (typeof value === "boolean") {
      prepared.bindBoolean(index, value);
    } else {
      prepared.bindVarchar(index, String(value));
    }
  }
}
