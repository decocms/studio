/**
 * Database Factory for MCP Mesh
 *
 * Auto-detects database dialect from DATABASE_URL and returns configured Kysely instance.
 * Supports SQLite (default) and PostgreSQL.
 *
 * Returns a MeshDatabase discriminated union that includes:
 * - The Kysely instance
 * - Database type for runtime discrimination
 * - For PostgreSQL: the shared Pool (reusable for LISTEN/NOTIFY)
 */

import { existsSync, mkdirSync } from "fs";
import { type Dialect, Kysely, LogEvent, PostgresDialect, sql } from "kysely";
import { BunWorkerDialect } from "kysely-bun-worker";
import * as path from "path";
import { Pool } from "pg";
import type { Database as DatabaseSchema } from "../storage/types";
import { meter } from "../observability";

// ============================================================================
// MeshDatabase Types - Discriminated Union
// ============================================================================

/**
 * OpenTelemetry histogram for database query durations
 * Records query execution time with the SQL statement as an attribute
 */
const queryDurationHistogram = meter.createHistogram("db.query.duration", {
  description: "Database query execution duration in milliseconds",
  unit: "ms",
});

const WELL_KNOWN_QUERY_ERRORS = [
  "PRAGMA busy_timeout = ?;",
  "SELECT current_database()",
];

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
      params: event.query.parameters,
    });
  }

  queryDurationHistogram.record(event.queryDurationMillis, attributes);

  if (
    event.level === "error" &&
    !WELL_KNOWN_QUERY_ERRORS.includes(event.query.sql)
  ) {
    console.error("Query failed:", {
      durationMs: event.queryDurationMillis,
      error: event.error,
      sql: event.query.sql,
    });
  }
};
/**
 * Supported database types
 */
export type DatabaseType = "sqlite" | "postgres";

/**
 * SQLite database connection
 */
export interface SqliteDatabase {
  type: "sqlite";
  db: Kysely<DatabaseSchema>;
}

/**
 * PostgreSQL database connection
 * Includes the Pool for reuse (e.g., LISTEN/NOTIFY in EventBus)
 */
export interface PostgresDatabase {
  type: "postgres";
  db: Kysely<DatabaseSchema>;
  pool: Pool;
}

/**
 * MeshDatabase - discriminated union of all supported database types
 * Use `database.type` to discriminate between implementations
 */
export type MeshDatabase = SqliteDatabase | PostgresDatabase;

// ============================================================================
// Internal Types
// ============================================================================

/**
 * Database configuration interface
 */
interface DatabaseConfig {
  type: DatabaseType;
  connectionString: string;
  options?: {
    maxConnections?: number; // For PostgreSQL
    enableWAL?: boolean; // For SQLite
    busyTimeout?: number; // For SQLite
  };
}

// ============================================================================
// PostgreSQL Implementation
// ============================================================================

const defaultPoolOptions = {
  // Keep connections alive to avoid reconnection latency across regions
  keepAlive: true,
  keepAliveInitialDelayMillis: 10000,
  // Allow connections to stay idle longer (5 min instead of default 10s)
  // This reduces reconnection overhead for cross-region databases
  idleTimeoutMillis: 300000,
  // Increase connection timeout for high-latency networks (30s)
  connectionTimeoutMillis: 30000,
  // Allow the process to exit even with idle connections
  allowExitOnIdle: true,
};
function createPostgresDatabase(config: DatabaseConfig): PostgresDatabase {
  const pool = new Pool({
    connectionString: config.connectionString,
    max: config.options?.maxConnections || 10,
    ssl: process.env.DATABASE_PG_SSL === "true" ? true : false,
    ...defaultPoolOptions,
  });

  const dialect = new PostgresDialect({ pool });
  const db = new Kysely<DatabaseSchema>({
    dialect,
    log,
  });

  return { type: "postgres", db, pool };
}

// ============================================================================
// SQLite Implementation
// ============================================================================

function extractSqlitePath(connectionString: string): string {
  // Handle ":memory:" special case
  if (connectionString === ":memory:") {
    return ":memory:";
  }

  // Parse URL if it has a protocol
  if (connectionString.includes("://")) {
    const url = new URL(connectionString);
    return url.pathname;
  }

  // Otherwise treat as direct path
  return connectionString;
}

function ensureSqliteDirectory(dbPath: string): string {
  if (dbPath !== ":memory:" && dbPath !== "/" && dbPath) {
    const dir = dbPath.substring(0, dbPath.lastIndexOf("/"));
    if (dir && dir !== "/" && !existsSync(dir)) {
      try {
        mkdirSync(dir, { recursive: true });
      } catch {
        // If directory creation fails, use in-memory database
        console.warn(
          `Failed to create directory ${dir}, using in-memory database`,
        );
        return ":memory:";
      }
    }
  }
  return dbPath;
}

function createSqliteDatabase(config: DatabaseConfig): SqliteDatabase {
  let dbPath = extractSqlitePath(config.connectionString);
  dbPath = ensureSqliteDirectory(dbPath);

  const dialect = new BunWorkerDialect({
    url: dbPath || ":memory:",
  });

  const db = new Kysely<DatabaseSchema>({
    dialect,
    log,
  });

  // Enable foreign keys (required for FK constraints to work in SQLite)
  // Skip in test environment to avoid breaking existing tests
  const isTest =
    process.env.NODE_ENV === "test" || process.env.BUN_ENV === "test";
  if (!isTest) {
    sql`PRAGMA foreign_keys = ON;`.execute(db).catch(() => {
      // Ignore errors
    });
  }

  // Enable WAL mode and busy timeout for non-memory databases
  if (dbPath !== ":memory:" && config.options?.enableWAL !== false) {
    sql`PRAGMA journal_mode = WAL;`.execute(db).catch(() => {
      // Ignore errors - might already be in WAL mode
    });
  }

  if (dbPath !== ":memory:") {
    const timeout = config.options?.busyTimeout || 5000;
    sql`PRAGMA busy_timeout = ${timeout};`.execute(db).catch(() => {
      // Ignore errors
    });
  }

  return { type: "sqlite", db };
}

// ============================================================================
// URL Parsing
// ============================================================================

/**
 * Parse database URL and extract configuration
 */
function parseDatabaseUrl(databaseUrl?: string): DatabaseConfig {
  let url = databaseUrl || "file:./data/mesh.db";

  // Handle special case: ":memory:" without protocol
  if (url === ":memory:") {
    return {
      type: "sqlite",
      connectionString: ":memory:",
    };
  }

  // Add file:// prefix for absolute paths
  url = url.startsWith("/") ? `file://${url}` : url;

  const parsed = URL.canParse(url) ? new URL(url) : null;
  const protocol = parsed?.protocol.replace(":", "") ?? url.split("://")[0];

  switch (protocol) {
    case "postgres":
    case "postgresql":
      return {
        type: "postgres",
        connectionString: url,
      };

    case "sqlite":
    case "file":
      if (!parsed?.pathname) {
        throw new Error("Invalid database URL: " + url);
      }
      return {
        type: "sqlite",
        connectionString: parsed.pathname,
      };

    default:
      throw new Error(
        `Unsupported database protocol: ${protocol}. ` +
          `Supported protocols: postgres://, postgresql://, sqlite://, file://`,
      );
  }
}

// ============================================================================
// Public API
// ============================================================================

/**
 * Get database URL from environment or default
 */
export function getDatabaseUrl(): string {
  const databaseUrl =
    process.env.DATABASE_URL ||
    `file:${path.join(process.cwd(), "data/mesh.db")}`;
  return databaseUrl;
}

/**
 * Create a Kysely dialect for the given database URL
 * This allows you to create a dialect without creating the full MeshDatabase
 */
export function getDbDialect(databaseUrl?: string): Dialect {
  const config = parseDatabaseUrl(databaseUrl);

  if (config.type === "postgres") {
    return new PostgresDialect({
      pool: new Pool({
        connectionString: config.connectionString,
        max: config.options?.maxConnections || 10,
        ssl: process.env.DATABASE_PG_SSL === "true" ? true : false,
        ...defaultPoolOptions,
      }),
    });
  }

  let dbPath = extractSqlitePath(config.connectionString);
  dbPath = ensureSqliteDirectory(dbPath);
  return new BunWorkerDialect({ url: dbPath || ":memory:" });
}

/**
 * Create MeshDatabase instance with auto-detected dialect
 *
 * Returns a discriminated union - use `database.type` to check the type:
 * - "sqlite": SqliteDatabase with { db }
 * - "postgres": PostgresDatabase with { db, pool }
 */
export function createDatabase(databaseUrl?: string): MeshDatabase {
  const config = parseDatabaseUrl(databaseUrl);

  if (config.type === "postgres") {
    return createPostgresDatabase(config);
  }

  return createSqliteDatabase(config);
}

/**
 * Close database connection
 * Handles both SQLite and PostgreSQL (including Pool cleanup)
 */
export async function closeDatabase(database: MeshDatabase): Promise<void> {
  await database.db.destroy();

  // PostgreSQL: also close the pool
  if (database.type === "postgres" && !database.pool.ended) {
    await database.pool.end();
  }
}

/**
 * Default database instance (singleton)
 * Lazy-initialized to avoid errors during module import
 */
let dbInstance: MeshDatabase | null = null;

export function getDb(): MeshDatabase {
  if (!dbInstance) {
    dbInstance = createDatabase(getDatabaseUrl());
  }
  return dbInstance;
}
