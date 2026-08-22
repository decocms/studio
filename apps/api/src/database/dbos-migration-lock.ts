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

import { sleep } from "@decocms/shared/std";
import pg from "pg";

/**
 * Fixed 64-bit key for this lock. Arbitrary, but must never change: two builds
 * disagreeing on it would not exclude each other. Advisory locks share one
 * namespace per database, hence a value unlikely to collide with anything else.
 */
const DBOS_MIGRATION_LOCK_KEY = 8_314_027_461_559_302n;

/**
 * How long to keep trying before giving up. A cold migration applies every
 * migration the SDK ships and can take minutes, so this is generous. Failing
 * beats blocking forever: the pod exits, Kubernetes restarts it, and the retry
 * finds the work already done.
 */
const LOCK_TIMEOUT_MS = 10 * 60 * 1000;

/** Gap between attempts. Short enough to start promptly, long enough to idle. */
const POLL_INTERVAL_MS = 500;

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
  // so it must be released by closing exactly this.
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();

  const startedAt = Date.now();
  let acquired = false;
  try {
    // Poll with try-lock and sit IDLE between attempts. Blocking in
    // `pg_advisory_lock()` would deadlock the very thing we are protecting:
    // several of the DBOS migrations are `CREATE INDEX CONCURRENTLY`, whose
    // second phase waits for every concurrent virtual transaction in the
    // database to finish — and a backend parked inside a blocking
    // `pg_advisory_lock()` is an *active statement*, so it holds a virtualxid
    // and never finishes. The holder would wait on the waiters' virtualxids
    // while the waiters wait on the holder's lock. Postgres does not report
    // that as a deadlock (a CIC's virtualxid wait is not in the detector's
    // graph), so it hangs until the timeout. Observed exactly this: the holder
    // stuck on `CREATE INDEX CONCURRENTLY ... idx_workflow_status_forked_from`
    // with two backends parked in pg_advisory_lock. An idle session holds no
    // virtualxid, so polling keeps CIC unblocked.
    while (!acquired) {
      const res = await client.query<{ locked: boolean }>(
        "SELECT pg_try_advisory_lock($1) AS locked",
        [DBOS_MIGRATION_LOCK_KEY.toString()],
      );
      acquired = res.rows[0]?.locked === true;
      if (acquired) break;

      if (Date.now() - startedAt >= lockTimeoutMs) {
        throw new Error(
          `Timed out after ${lockTimeoutMs}ms waiting for the DBOS migration lock. ` +
            `Another process is still migrating the dbos schema; this pod will restart and retry.`,
        );
      }
      // Client-side sleep, deliberately: `pg_sleep()` would keep the statement
      // active and reintroduce the virtualxid that blocks CREATE INDEX
      // CONCURRENTLY.
      await sleep(POLL_INTERVAL_MS);
    }

    const waitedMs = Date.now() - startedAt;
    if (waitedMs > 1000) {
      log(
        `[dbos] waited ${waitedMs}ms for the migration lock; another process migrated first`,
      );
    }

    return await fn();
  } finally {
    if (acquired) {
      try {
        await client.query("SELECT pg_advisory_unlock($1)", [
          DBOS_MIGRATION_LOCK_KEY.toString(),
        ]);
      } catch {
        // Releasing on disconnect is the backstop; a failure here is not fatal.
      }
    }
    await client.end().catch(() => {});
  }
}
