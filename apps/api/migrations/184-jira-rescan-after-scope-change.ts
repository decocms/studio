import { type Kysely, sql } from "kysely";

/**
 * Clear every Jira integration's watermark, forcing one full re-scan.
 *
 * `last_synced_at` means "every issue in scope up to here has been processed".
 * Migration 182 changed what "in scope" means — the board's saved filter,
 * backlog included, instead of the board's visible cards — so every stored
 * watermark now vouches for a smaller set than the one being synced. The
 * issues that were skipped under the old scope have `updated` timestamps
 * BEHIND the watermark, so the new code would never ask for them: on a real
 * board, 47 issues filed in the backlog stayed invisible even after the fix,
 * until someone touched each one in Jira by hand.
 *
 * Deliberately a migration and not a runbook step. The rescan is a consequence
 * of the deploy, not an operator's decision, and a scope change whose repair
 * depends on someone remembering a SQL statement is a scope change that
 * silently doesn't apply.
 *
 * Safe to run: a null watermark is the initial-import path, which is
 * idempotent (the link table's UNIQUE dedupes every issue) and deliberately
 * suppresses auto-delegation, so a re-scan cannot dispatch a paid agent run
 * per pre-existing card. `MAX_ISSUES_PER_RUN` paces the rest.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    UPDATE org_jira_integrations
       SET last_synced_at = NULL,
           last_sync_error = NULL
     WHERE last_synced_at IS NOT NULL
  `.execute(db);
}

/** Nothing to restore: the old watermark described a scope that no longer
 *  exists, and re-scanning is the only correct state either way. */
export async function down(): Promise<void> {}
