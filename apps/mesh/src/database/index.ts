/**
 * Database Factory for MCP Mesh
 *
 * Creates a configured Kysely instance backed by PostgreSQL.
 * Returns a MeshDatabase that includes the Kysely instance and the
 * shared Pool (reusable for LISTEN/NOTIFY).
 */

import { type Dialect, Kysely, type LogEvent, PostgresDialect } from "kysely";
import { Pool } from "pg";
import type { Database as DatabaseSchema } from "../storage/types";
import { env } from "../env";
import { meter } from "../observability";

// ============================================================================
// MeshDatabase Types
// ============================================================================

const queryDurationHistogram = meter.createHistogram("db.query.duration", {
  description: "Database query execution duration in milliseconds",
  unit: "ms",
});

const SLOW_QUERY_TRESHOLD_MS = 400;
const log = (event: LogEvent) => {
  const attributes = {
    "db.statement": event.query.sql,
    "db.status": event.level === "error" ? "error" : "success",
  };

  if (event.queryDurationMillis > SLOW_QUERY_TRESHOLD_MS) {
    console.error("Slow query detected:", {
      durationMs: event.queryDurationMillis,
      sql: event.query.sql,
    });
  }

  queryDurationHistogram.record(event.queryDurationMillis, attributes);

  if (event.level === "error") {
    console.error("Query failed:", {
      durationMs: event.queryDurationMillis,
      error: event.error,
      sql: event.query.sql,
    });
  }
};

/**
 * PostgreSQL database connection.
 * Includes the Pool for reuse (e.g., LISTEN/NOTIFY in EventBus).
 */
export interface MeshDatabase {
  type: "postgres";
  db: Kysely<DatabaseSchema>;
  pool: Pool;
}

// ============================================================================
// PostgreSQL Implementation
// ============================================================================

const defaultPoolOptions = {
  keepAlive: true,
  keepAliveInitialDelayMillis: 10000,
  idleTimeoutMillis: 300000,
  connectionTimeoutMillis: 30000,
  allowExitOnIdle: true,
};

function createPostgresDatabase(connectionString: string): MeshDatabase {
  const pool = new Pool({
    connectionString,
    max: 10,
    ssl: env.DATABASE_PG_SSL,
    ...defaultPoolOptions,
  });

  const dialect = new PostgresDialect({ pool });
  const db = new Kysely<DatabaseSchema>({ dialect, log });

  return { type: "postgres", db, pool };
}

// ============================================================================
// Public API
// ============================================================================

export function getDatabaseUrl(): string {
  return env.DATABASE_URL;
}

/**
 * Create a Kysely dialect for the given database URL.
 */
export function getDbDialect(databaseUrl?: string): Dialect {
  const url = databaseUrl || getDatabaseUrl();

  return new PostgresDialect({
    pool: new Pool({
      connectionString: url,
      max: 10,
      ssl: env.DATABASE_PG_SSL,
      ...defaultPoolOptions,
    }),
  });
}

export function createDatabase(databaseUrl?: string): MeshDatabase {
  const url = databaseUrl || getDatabaseUrl();
  return createPostgresDatabase(url);
}

export async function closeDatabase(database: MeshDatabase): Promise<void> {
  await database.db.destroy();

  if (!database.pool.ended) {
    await database.pool.end();
  }

  if (database === dbInstance) {
    dbInstance = null;
  }
}

let dbInstance: MeshDatabase | null = null;

export function getDb(): MeshDatabase {
  if (!dbInstance) {
    dbInstance = createDatabase(getDatabaseUrl());
  }
  return dbInstance;
}
