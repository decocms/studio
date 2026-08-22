/**
 * Serialises the DBOS system-schema migration across every process that boots
 * against the same database.
 *
 * `DBOS.launch()` migrates the `dbos` schema, and the SDK advances its version
 * with `UPDATE dbos.dbos_migrations SET version = $1` — no WHERE clause,
 * assuming the table holds exactly one row. The earliest migrations create that
 * table, and until it exists the bump is a no-op, so two processes arriving
 * together both fall through to the INSERT and leave two rows. Every later bump
 * then writes the same version into both rows, collides on the primary key, and
 * the schema version can never advance again. The database is bricked
 * permanently: it reproduces afterwards with a single pod, and only a manual
 * DELETE recovers it. A customer hit exactly this on a first install.
 *
 * The chart's migration Job is not sufficient on its own. Under Argo CD the
 * sync wave holds the Deployments until the Job finishes, but under plain
 * `helm install` the post-install hook starts alongside the first pods — and it
 * must be a post-install hook, because it consumes the release's ConfigMap and
 * Secret. Nor does scaling down help by itself: one pod runs two API containers
 * and the worker HPA's minReplicas overrides a zeroed replicaCount.
 *
 * So the guarantee belongs here, where it holds regardless of orchestrator,
 * replica count, containers per pod, or whether the operator ran the Job at
 * all. A session-scoped `pg_advisory_lock` makes the first process migrate
 * while the rest wait; they then find the version already at max and do
 * nothing. Postgres releases a session lock automatically when the connection
 * drops, so a process killed mid-migration cannot wedge the others.
 */

import pg from "pg";

/**
 * Fixed 64-bit key for this lock. Arbitrary, but must never change: two builds
 * disagreeing on it would not exclude each other. Advisory locks share one
 * namespace per database, hence a value unlikely to collide with anything else.
 */
const DBOS_MIGRATION_LOCK_KEY = 8_314_027_461_559_302n;

/**
 * How long to wait for the holder before giving up. A cold migration applies
 * every migration the SDK ships and can take minutes, so this is generous.
 * Failing beats blocking forever: the pod exits, Kubernetes restarts it, and
 * the retry finds the work already done.
 */
const LOCK_TIMEOUT_MS = 10 * 60 * 1000;

export interface DbosMigrationLockOptions {
  /** Postgres URL, already passed through withSslmode() by the caller. */
  databaseUrl: string;
  /** Overrides the wait budget. Tests use this; production should not. */
  lockTimeoutMs?: number;
  /** Defaults to console.log. */
  log?: (message: string) => void;
}

/**
 * Runs `fn` while holding the migration lock. Always releases, including when
 * `fn` throws — the caller's error propagates unchanged.
 */
export async function withDbosMigrationLock<T>(
  options: DbosMigrationLockOptions,
  fn: () => Promise<T>,
): Promise<T> {
  const { databaseUrl, lockTimeoutMs = LOCK_TIMEOUT_MS } = options;
  const log = options.log ?? ((message: string) => console.log(message));

  // A dedicated connection, not a pooled one: the lock lives on the session,
  // so it must outlive nothing else and be released by closing exactly this.
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();

  const startedAt = Date.now();
  try {
    // lock_timeout bounds the wait itself; without it a stuck holder blocks
    // this process forever with no signal.
    await client.query(`SET lock_timeout = ${Math.floor(lockTimeoutMs)}`);
    try {
      await client.query("SELECT pg_advisory_lock($1)", [
        DBOS_MIGRATION_LOCK_KEY.toString(),
      ]);
    } catch (error) {
      // 55P03 lock_not_available — someone else is still migrating.
      const code = (error as { code?: string } | null)?.code;
      if (code === "55P03") {
        throw new Error(
          `Timed out after ${lockTimeoutMs}ms waiting for the DBOS migration lock. ` +
            `Another process is still migrating the dbos schema; this pod will restart and retry.`,
          { cause: error },
        );
      }
      throw error;
    }

    const waitedMs = Date.now() - startedAt;
    if (waitedMs > 1000) {
      log(
        `[dbos] waited ${waitedMs}ms for the migration lock; another process migrated first`,
      );
    }

    return await fn();
  } finally {
    // end() drops the session, which releases the lock even if the unlock
    // below fails — the explicit call just makes the release immediate and the
    // intent obvious.
    try {
      await client.query("SELECT pg_advisory_unlock($1)", [
        DBOS_MIGRATION_LOCK_KEY.toString(),
      ]);
    } catch {
      // Releasing on disconnect is the backstop; a failure here is not fatal.
    }
    await client.end().catch(() => {});
  }
}
