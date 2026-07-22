/**
 * Database Factory for Studio
 *
 * Creates a configured Kysely instance backed by PostgreSQL.
 * Returns a StudioDatabase that includes the Kysely instance and the
 * shared Pool (reusable for LISTEN/NOTIFY).
 */

import { type Dialect, Kysely, type LogEvent, PostgresDialect } from "kysely";
import { Pool } from "pg";
import type { Database as DatabaseSchema } from "../storage/types";
import { getSettings } from "../settings";
import { meter } from "../observability";
import { getEventLoopLagMs } from "../observability/profiling/event-loop";

// ============================================================================
// StudioDatabase Types
// ============================================================================

// Resolve the instrument on every record, never cached: the module-level
// `meter` is the NoopMeter until initObservability() reassigns it, so caching
// the first instance (e.g. when an early query races init) binds the dead meter
// forever. createHistogram is idempotent — the meter memoizes by name — so this
// is cheap and always hits the real post-init provider. Mirrors the working
// pattern in mcp-clients/outbound/transports/monitoring.ts.
const queryDurationHistogram = () =>
  meter.createHistogram("db.query.duration", {
    description: "Database query execution duration in milliseconds",
    unit: "ms",
  });

// Kysely's queryDurationMillis measures SQL execution only — the timer starts
// after the connection is checked out of the pool. Pool-acquisition wait is
// invisible to it, so we measure that separately to tell genuinely slow SQL
// apart from pool-capacity contention.
const poolAcquireHistogram = () =>
  meter.createHistogram("db.pool.acquire.duration", {
    description: "Time spent waiting to acquire a connection from the pool",
    unit: "ms",
  });

const SLOW_QUERY_TRESHOLD_MS = 400;
const SLOW_ACQUIRE_THRESHOLD_MS = 100;

const createLog = (pool: Pool) => (event: LogEvent) => {
  const attributes = {
    "db.statement": event.query.sql,
    "db.status": event.level === "error" ? "error" : "success",
  };

  if (event.queryDurationMillis > SLOW_QUERY_TRESHOLD_MS) {
    // Kysely's queryDurationMillis is measured in JS: the timer starts when the
    // query is dispatched and stops in the result callback, so a blocked event
    // loop inflates the figure even when Postgres answered in sub-ms. When
    // recent loop lag is on the same order as the "slow" duration, the SQL is
    // almost certainly fast and the loop is the real bottleneck — say so
    // instead of blaming the DB. See observability/profiling/event-loop.ts.
    const eventLoopLagMs = getEventLoopLagMs();
    const likelyEventLoopLag = eventLoopLagMs > SLOW_QUERY_TRESHOLD_MS / 2;
    console.error(
      likelyEventLoopLag
        ? "Slow query measurement — likely event-loop lag, not slow SQL:"
        : "Slow query detected:",
      {
        durationMs: event.queryDurationMillis,
        eventLoopLagMs: Math.round(eventLoopLagMs),
        sql: event.query.sql,
        pool: {
          total: pool.totalCount,
          idle: pool.idleCount,
          waiting: pool.waitingCount,
          max: getPoolMax(),
        },
      },
    );
  }

  queryDurationHistogram().record(event.queryDurationMillis, attributes);

  if (event.level === "error") {
    console.error("Query failed:", {
      durationMs: event.queryDurationMillis,
      error: event.error,
      sql: event.query.sql,
    });
  }
};

/**
 * Wrap pool.connect() to measure connection-acquisition wait and pool
 * saturation. Kysely uses the promise form; the callback form is delegated
 * untouched.
 */
function instrumentPool(pool: Pool): Pool {
  const originalConnect = pool.connect.bind(pool);
  // @ts-expect-error pg's connect has callback/promise overloads
  pool.connect = (cb?: unknown) => {
    if (typeof cb === "function") return originalConnect(cb as never);
    const start = performance.now();
    // Snapshot BEFORE waiting: pg hands out an idle client when one exists, so
    // if any are idle here a slow resolve is event-loop lag (pg defers the
    // handoff through process.nextTick), NOT pool-capacity contention. Only a
    // full pool with zero idle is genuine contention.
    const max = getPoolMax();
    const contended = pool.idleCount === 0 && pool.totalCount >= max;
    const idleAtStart = pool.idleCount;
    return originalConnect().then(
      (client) => {
        const waited = performance.now() - start;
        poolAcquireHistogram().record(waited, {
          "db.pool.outcome": contended ? "contended" : "available",
        });
        if (waited > SLOW_ACQUIRE_THRESHOLD_MS) {
          if (contended) {
            console.error("Slow db pool acquire — pool saturated:", {
              waitMs: waited,
              total: pool.totalCount,
              idle: pool.idleCount,
              waiting: pool.waitingCount,
              max,
            });
          } else {
            // A connection was free; the delay is the event loop being blocked,
            // not the DB pool. See observability/profiling/event-loop.ts.
            console.warn("Slow db pool acquire — event-loop lag (not pool):", {
              waitMs: waited,
              idleAtStart,
              total: pool.totalCount,
              max,
            });
          }
        }
        return client;
      },
      (err) => {
        poolAcquireHistogram().record(performance.now() - start, {
          "db.pool.outcome": "error",
        });
        throw err;
      },
    );
  };
  return pool;
}

/**
 * PostgreSQL database connection.
 * Includes the Pool for reuse (e.g., LISTEN/NOTIFY in EventBus).
 */
export interface StudioDatabase {
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

function getSsl(): boolean {
  try {
    return getSettings().databasePgSsl;
  } catch {
    return false; // Settings not yet initialized (e.g., during pipeline migrations)
  }
}

function getPoolMax(): number {
  try {
    return getSettings().databasePoolMax;
  } catch {
    return 10; // Settings not yet initialized (e.g., during pipeline migrations)
  }
}

function createPostgresDatabase(connectionString: string): StudioDatabase {
  const pool = instrumentPool(
    new Pool({
      connectionString,
      max: getPoolMax(),
      ssl: getSsl(),
      ...defaultPoolOptions,
    }),
  );

  const dialect = new PostgresDialect({ pool });
  const db = new Kysely<DatabaseSchema>({ dialect, log: createLog(pool) });

  return { type: "postgres", db, pool };
}

// ============================================================================
// Public API
// ============================================================================

export function getDatabaseUrl(): string {
  return getSettings().databaseUrl;
}

/** Append `sslmode=verify-full` when SSL is required and not already set. */
export function withSslmode(url: string, ssl: boolean): string {
  if (!ssl) return url;
  const u = new URL(url);
  if (!u.searchParams.has("sslmode")) {
    u.searchParams.set("sslmode", "verify-full");
  }
  return u.toString();
}

/**
 * Create a Kysely dialect for the given database URL.
 */
export function getDbDialect(databaseUrl?: string): Dialect {
  const url = databaseUrl || getDatabaseUrl();

  return new PostgresDialect({
    pool: new Pool({
      connectionString: url,
      max: getPoolMax(),
      ssl: getSsl(),
      ...defaultPoolOptions,
    }),
  });
}

export function createDatabase(databaseUrl?: string): StudioDatabase {
  const url = databaseUrl || getDatabaseUrl();
  return createPostgresDatabase(url);
}

export async function closeDatabase(database: StudioDatabase): Promise<void> {
  await database.db.destroy();

  if (!database.pool.ended) {
    await database.pool.end();
  }

  if (database === dbInstance) {
    dbInstance = null;
  }
}

let dbInstance: StudioDatabase | null = null;

export function getDb(): StudioDatabase {
  if (!dbInstance) {
    dbInstance = createDatabase(getDatabaseUrl());
  }
  return dbInstance;
}
