/**
 * Database Factory for MCP Mesh
 *
 * Auto-detects database dialect from DATABASE_URL and returns configured Kysely instance.
 * Supports PGlite (default, local PostgreSQL via WASM) and PostgreSQL (cloud).
 *
 * Returns a MeshDatabase discriminated union that includes:
 * - The Kysely instance
 * - Database type for runtime discrimination
 * - For PostgreSQL: the shared Pool (reusable for LISTEN/NOTIFY)
 * - For PGlite: the PGlite instance (for lifecycle management)
 */

import { existsSync, mkdirSync } from "fs";
import { type Dialect, Kysely, LogEvent, PostgresDialect } from "kysely";
import { PGlite } from "@electric-sql/pglite";
import { KyselyPGlite } from "kysely-pglite";
import * as path from "path";
import { Pool } from "pg";
import type { Database as DatabaseSchema } from "../storage/types";
import { meter } from "../observability";

// ============================================================================
// MeshDatabase Types - Discriminated Union
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
 * Supported database types
 */
export type DatabaseType = "pglite" | "postgres";

/**
 * PGlite database connection (local PostgreSQL via WASM)
 * Exposes the PGlite instance for lifecycle management and sharing.
 */
export interface PGliteDatabase {
  type: "pglite";
  db: Kysely<DatabaseSchema>;
  pglite: PGlite;
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
export type MeshDatabase = PGliteDatabase | PostgresDatabase;

// ============================================================================
// Internal Types
// ============================================================================

interface DatabaseConfig {
  type: DatabaseType;
  connectionString: string;
  options?: {
    maxConnections?: number;
  };
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

function createPostgresDatabase(config: DatabaseConfig): PostgresDatabase {
  const pool = new Pool({
    connectionString: config.connectionString,
    max: config.options?.maxConnections || 10,
    ssl: process.env.DATABASE_PG_SSL === "true" ? true : false,
    ...defaultPoolOptions,
  });

  const dialect = new PostgresDialect({ pool });
  const db = new Kysely<DatabaseSchema>({ dialect, log });

  return { type: "postgres", db, pool };
}

// ============================================================================
// PGlite Implementation
// ============================================================================

function ensurePGliteDirectory(dataDir: string): string {
  if (dataDir === ":memory:" || !dataDir) {
    return ":memory:";
  }

  if (dataDir !== "/" && !existsSync(dataDir)) {
    try {
      mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    } catch {
      console.warn(
        `Failed to create directory ${dataDir}, using in-memory database`,
      );
      return ":memory:";
    }
  }
  return dataDir;
}

function extractPGlitePath(connectionString: string): string {
  if (connectionString === ":memory:") {
    return ":memory:";
  }

  if (connectionString.includes("://")) {
    const url = new URL(connectionString);
    return url.pathname;
  }

  return connectionString;
}

function createPGliteInstance(dataDir: string): PGlite {
  const resolvedDir = ensurePGliteDirectory(dataDir);
  return new PGlite(resolvedDir === ":memory:" ? undefined : resolvedDir);
}

function createPGliteDatabase(config: DatabaseConfig): PGliteDatabase {
  const dataDir = extractPGlitePath(config.connectionString);
  const pglite = createPGliteInstance(dataDir);

  const kpg = new KyselyPGlite(pglite);
  const db = new Kysely<DatabaseSchema>({ dialect: kpg.dialect, log });

  return { type: "pglite", db, pglite };
}

// ============================================================================
// URL Parsing
// ============================================================================

function parseDatabaseUrl(databaseUrl?: string): DatabaseConfig {
  let url = databaseUrl || "file:./data/mesh.pglite";

  if (url === ":memory:") {
    return { type: "pglite", connectionString: ":memory:" };
  }

  url = url.startsWith("/") ? `file://${url}` : url;

  const parsed = URL.canParse(url) ? new URL(url) : null;
  const protocol = parsed?.protocol.replace(":", "") ?? url.split("://")[0];

  switch (protocol) {
    case "postgres":
    case "postgresql":
      return { type: "postgres", connectionString: url };

    case "sqlite":
      console.warn(
        "[Database] sqlite:// protocol is deprecated. Use file:// instead. " +
          "SQLite has been replaced by PGlite (embedded PostgreSQL).",
      );
      if (!parsed?.pathname) {
        throw new Error("Invalid database URL: " + url);
      }
      return { type: "pglite", connectionString: parsed.pathname };

    case "file":
      if (!parsed?.pathname) {
        throw new Error("Invalid database URL: " + url);
      }
      return { type: "pglite", connectionString: parsed.pathname };

    default:
      throw new Error(
        `Unsupported database protocol: ${protocol}. ` +
          `Supported protocols: postgres://, postgresql://, file://`,
      );
  }
}

// ============================================================================
// Public API
// ============================================================================

export function getDatabaseUrl(): string {
  const databaseUrl =
    process.env.DATABASE_URL ||
    `file:${path.join(process.cwd(), "data/mesh.pglite")}`;
  return databaseUrl;
}

/**
 * Create a Kysely dialect for the given database URL.
 * For PGlite, reuses the singleton PGlite instance from getDb() when available
 * to avoid dual-instance conflicts on the same data directory.
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

  // Reuse the singleton PGlite instance if available to avoid data directory conflicts
  if (dbInstance && dbInstance.type === "pglite") {
    return new KyselyPGlite(dbInstance.pglite).dialect;
  }

  const dataDir = extractPGlitePath(config.connectionString);
  const pglite = createPGliteInstance(dataDir);
  return new KyselyPGlite(pglite).dialect;
}

export function createDatabase(databaseUrl?: string): MeshDatabase {
  const config = parseDatabaseUrl(databaseUrl);

  if (config.type === "postgres") {
    return createPostgresDatabase(config);
  }

  return createPGliteDatabase(config);
}

export async function closeDatabase(database: MeshDatabase): Promise<void> {
  await database.db.destroy();

  if (database.type === "postgres" && !database.pool.ended) {
    await database.pool.end();
  }

  if (database.type === "pglite") {
    try {
      await database.pglite.close();
    } catch {
      // PGlite may already be closed by Kysely's destroy()
    }
  }
}

let dbInstance: MeshDatabase | null = null;

export function getDb(): MeshDatabase {
  if (!dbInstance) {
    dbInstance = createDatabase(getDatabaseUrl());
  }
  return dbInstance;
}
