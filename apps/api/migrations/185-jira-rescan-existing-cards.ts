import { type Kysely, sql } from "kysely";

/**
 * Clear every Jira integration's watermark again, because migration 184's
 * rescan only did half the job.
 *
 * 184 cleared the watermark so the widened scope would be re-read, and it
 * worked for the cards that were MISSING: 50 arrived on the first tick. But
 * the pull's "nothing to do" shortcut fires before any field is written — an
 * issue whose link already recorded its `updated` was skipped outright — so
 * every card that already existed kept the `sprint_id` it never had. The board
 * came out of the rescan showing 253 issues that Jira has in a sprint as
 * backlog.
 *
 * `isUnchanged` now refuses that shortcut on a rescan, which makes clearing the
 * watermark mean what 184 assumed it meant. This is the second clear, the one
 * that actually refreshes the cards.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    UPDATE org_jira_integrations
       SET last_synced_at = NULL,
           last_sync_error = NULL
     WHERE last_synced_at IS NOT NULL
  `.execute(db);
}

/** Nothing to restore — see 184. */
export async function down(): Promise<void> {}
