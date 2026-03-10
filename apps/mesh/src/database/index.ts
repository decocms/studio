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
import { homedir } from "os";
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
    } catch (error) {
      if (process.env.NODE_ENV === "production") {
        throw new Error(`Failed to create PGlite data directory: ${dataDir}`, {
          cause: error,
        });
      }
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
    // Strip protocol and resolve to avoid WHATWG URL mis-parsing relative paths
    const raw = connectionString.replace(/^\w+:\/\//, "");
    return path.resolve(raw);
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

const DEFAULT_PGLITE_PATH = path.join(
  process.env.DECOCMS_HOME || path.join(homedir(), "deco"),
  "db.pglite",
);

function parseDatabaseUrl(databaseUrl?: string): DatabaseConfig {
  let url = databaseUrl || getDatabaseUrl();

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

    case "file": {
      // file:// URLs with relative paths (e.g. "file://./data/mesh") are
      // mis-parsed by the WHATWG URL spec — the "./" becomes the host and only
      // the trailing segment ends up in pathname.  Strip the protocol prefix
      // and resolve relative paths manually to avoid this footgun.
      const raw = url.replace(/^file:(?:\/\/(?:localhost(?=\/|$))?)?/, "");
      if (!raw) {
        throw new Error("Invalid database URL: " + url);
      }
      const resolved = path.resolve(raw);
      return { type: "pglite", connectionString: resolved };
    }

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
    process.env.DATABASE_URL || `file://${DEFAULT_PGLITE_PATH}`;
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

  // For PGlite, always go through getDb() to ensure a single instance.
  // Multiple PGlite instances on the same data directory cause file lock conflicts.
  // NOTE: The `databaseUrl` parameter is effectively ignored for PGlite — the
  // singleton from getDb() (which uses getDatabaseUrl()) is always returned.
  const db = getDb();
  if (db.type === "pglite") {
    // Warn if the caller requested a specific PGlite path that differs from the singleton.
    if (databaseUrl) {
      const requestedConfig = parseDatabaseUrl(databaseUrl);
      if (
        requestedConfig.type === "pglite" &&
        requestedConfig.connectionString !== ":memory:"
      ) {
        const singletonConfig = parseDatabaseUrl(getDatabaseUrl());
        if (
          singletonConfig.type === "pglite" &&
          requestedConfig.connectionString !== singletonConfig.connectionString
        ) {
          console.warn(
            `getDbDialect(): requested PGlite path "${requestedConfig.connectionString}" ` +
              `differs from singleton path "${singletonConfig.connectionString}". ` +
              `The singleton instance will be used.`,
          );
        }
      }
    }
    return new KyselyPGlite(db.pglite).dialect;
  }

  // Unreachable: config.type is "pglite" but the singleton is "postgres".
  // This indicates a DATABASE_URL mismatch between the singleton and this call.
  throw new Error(
    "Invariant violation: getDbDialect resolved a PGlite config but the " +
      "database singleton is PostgreSQL. Ensure DATABASE_URL is consistent.",
  );
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
    } catch (error) {
      // PGlite may already be closed by Kysely's destroy()
      if (!(error instanceof Error) || !error.message.includes("is closed")) {
        throw error;
      }
    }
  }

  // Clear the singleton if it was the instance being closed,
  // so subsequent getDb() calls create a fresh instance.
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
