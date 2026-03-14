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

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { type Dialect, Kysely, LogEvent, PostgresDialect } from "kysely";
import { PGlite } from "@electric-sql/pglite";
import { KyselyPGlite } from "kysely-pglite";
import * as path from "path";
import { Pool } from "pg";
import type { Database as DatabaseSchema } from "../storage/types";
import { env } from "../env";
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
    ssl: env.DATABASE_PG_SSL,
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
      if (env.NODE_ENV === "production") {
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

function clearStalePGliteLock(dataDir: string): void {
  const pidFile = path.join(dataDir, "postmaster.pid");
  if (!existsSync(pidFile)) return;

  try {
    const raw = readFileSync(pidFile, "utf8").trim();
    const pid = parseInt(raw.split("\n")[0] ?? "", 10);

    // Negative or NaN PID is always stale (PGlite WASM uses -42)
    const isAlive =
      pid > 0 &&
      (() => {
        try {
          process.kill(pid, 0);
          return true;
        } catch (err) {
          return (err as NodeJS.ErrnoException).code === "EPERM";
        }
      })();

    if (!isAlive) {
      rmSync(pidFile);
    }
  } catch {
    // If we can't read/parse the pid file, leave it alone
  }
}

// ============================================================================
// Process-level PGlite Lock
// ============================================================================
// PGlite (WASM) writes postmaster.pid with PID -42, which is meaningless for
// cross-process exclusion. We maintain our own .mesh.lock with a real PID so
// concurrent processes (e.g. two worktrees) detect each other instead of
// silently corrupting the database.

const MESH_LOCK_FILE = ".mesh.lock";
let meshLockCleanup: (() => void) | null = null;

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

function acquirePGliteLock(dataDir: string): void {
  // Skip lock in test environment — tests use in-memory or share the DB read-only
  if (env.NODE_ENV === "test") return;

  const lockPath = path.join(dataDir, MESH_LOCK_FILE);

  if (existsSync(lockPath)) {
    try {
      const raw = readFileSync(lockPath, "utf8").trim();
      const pid = parseInt(raw, 10);

      if (pid > 0 && isProcessAlive(pid)) {
        throw new Error(
          `\n🔒 Another mesh process (PID ${pid}) is using the database at ${dataDir}\n` +
            `   Stop the other process first, or set DATA_DIR to use a separate database.\n` +
            `   Example: DATA_DIR=~/deco/other bun run dev\n`,
        );
      }
      // Stale lock from crashed process — remove it
      rmSync(lockPath);
    } catch (err) {
      // Re-throw our own lock errors
      if (
        err instanceof Error &&
        err.message.includes("Another mesh process")
      ) {
        throw err;
      }
      // Can't read lock file — remove it
      try {
        rmSync(lockPath);
      } catch {}
    }
  }

  // Write our real PID
  writeFileSync(lockPath, String(process.pid));

  // Clean up on exit (normal, SIGINT, SIGTERM)
  const cleanup = () => {
    try {
      // Only remove if it's still our PID
      if (existsSync(lockPath)) {
        const content = readFileSync(lockPath, "utf8").trim();
        if (content === String(process.pid)) {
          rmSync(lockPath);
        }
      }
    } catch {}
  };

  meshLockCleanup = cleanup;
  process.on("exit", cleanup);
}

function createPGliteInstance(dataDir: string): PGlite {
  const resolvedDir = ensurePGliteDirectory(dataDir);
  if (resolvedDir !== ":memory:") {
    acquirePGliteLock(resolvedDir);
    clearStalePGliteLock(resolvedDir);
  }
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

// DATABASE_URL default is now derived from DATA_DIR in env.ts

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
  return env.DATABASE_URL;
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
        ssl: env.DATABASE_PG_SSL,
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
    // Release the PGlite lock
    if (meshLockCleanup) {
      meshLockCleanup();
      meshLockCleanup = null;
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
