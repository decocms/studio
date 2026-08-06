import { type Kysely, sql } from "kysely";

/**
 * Durable retry state for a task whose run failed on infrastructure.
 *
 * A failed run used to advance its card to In Review — the thread-finish hook
 * treated every terminal status alike, so eight tasks whose sandboxes never
 * came up ("Sandbox did not become ready within 180 seconds") landed in the
 * reviewers' lane with no PR and no work done. There was nothing to review and
 * no retry: a human had to notice and re-run each card.
 *
 * The retry has to survive a pod restart, so the schedule lives on the row
 * rather than in a timer: `retry_at` is when the card is next due for a
 * re-dispatch, `retry_attempts` is how many infrastructure retries it has
 * already spent (the cap that stops a permanently-broken cluster from looping
 * forever). Both are cleared when a run finally produces something.
 *
 * NULL `retry_at` means "not waiting on a retry" — the normal state for every
 * existing card, so no backfill.
 *
 * Deliberately not on `threads`: the unit being retried is the TASK, and each
 * attempt is a new thread. Counting attempts on the thread would reset the
 * budget every time we retried.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    ALTER TABLE task_board_items
      ADD COLUMN retry_at timestamptz,
      ADD COLUMN retry_attempts integer NOT NULL DEFAULT 0
  `.execute(db);

  // The retry sweep's work list: due cards only. Partial, so it stays the size
  // of the retry backlog (usually zero) rather than the whole board.
  await sql`
    CREATE INDEX idx_task_board_items_retry_due
      ON task_board_items (retry_at)
      WHERE retry_at IS NOT NULL
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP INDEX IF EXISTS idx_task_board_items_retry_due`.execute(db);
  await sql`
    ALTER TABLE task_board_items
      DROP COLUMN retry_at,
      DROP COLUMN retry_attempts
  `.execute(db);
}
