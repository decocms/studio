import { type Kysely, sql } from "kysely";

/**
 * Tracks whether a rescan (migration 184's scope change, 185's existing-card
 * fix, or a plain first import) is still in progress across runs — not just
 * within one.
 *
 * `isRescan` in sync.ts was `last_synced_at === null`, but a run only advances
 * the watermark as far as `MAX_ISSUES_PER_RUN`/`MAX_PAGES_PER_RUN` let it get
 * (that pacing is deliberate — see sync.ts). The FIRST run of a rescan on a
 * board with more mapped issues than one run's cap sets a non-null watermark
 * before the scope is fully re-read, so every following run reads
 * `last_synced_at !== null` and treats itself as a normal incremental sync —
 * silently reverting to `isUnchanged`'s shortcut for the issues the rescan
 * never got to. On a board over the cap, 185's fix would only have reached
 * its first ~500 issues.
 *
 * `rescan_pending` survives across runs independently of the watermark, so
 * sync.ts can keep forcing a full re-read (and keep suppressing
 * auto-delegate) until a run finishes the scope without hitting a cap.
 *
 * Backfilled true for every integration already mid-rescan (185's WHERE
 * clause put those at `last_synced_at IS NULL`) so a deploy doesn't drop them
 * out of the rescan they're already in.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    ALTER TABLE org_jira_integrations
      ADD COLUMN rescan_pending boolean NOT NULL DEFAULT false
  `.execute(db);
  await sql`
    UPDATE org_jira_integrations
       SET rescan_pending = true
     WHERE last_synced_at IS NULL
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`ALTER TABLE org_jira_integrations DROP COLUMN rescan_pending`.execute(
    db,
  );
}
