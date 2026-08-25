import { type Kysely, sql } from "kysely";

/**
 * Index behind the archive sweep (`listItemsAwaitingArchive`) and the
 * merged-tag sweep (`listItemsAwaitingMergedTag`), both DBOS cron workflows
 * that run cross-org, forever, filtering `status = 'done' AND dismissed_at
 * IS NULL` — the exact same shape `idx_task_board_items_pending_review`
 * (migration 165) fixed for the review sweeper. `task_board_items` only had
 * an `organization_id` index, so both queries were a full scan of the table
 * on every tick.
 *
 * Partial on the sweeps' shared predicate so the index stays tiny — it holds
 * only Done, non-dismissed cards — and keyed on `updated_at`, the column both
 * queries order and filter by (ASC for the archive sweep, DESC for the
 * merged-tag sweep; a plain btree serves both directions).
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    CREATE INDEX idx_task_board_items_done_sweep
      ON task_board_items (updated_at)
      WHERE status = 'done' AND dismissed_at IS NULL
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropIndex("idx_task_board_items_done_sweep").execute();
}
