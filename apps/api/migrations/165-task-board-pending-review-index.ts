import { type Kysely, sql } from "kysely";

/**
 * Index behind the review sweeper's work list
 * (`TaskBoardStorage.listItemsPendingReview`): every pod runs that query once a
 * minute, forever, and `task_board_items` only had an `organization_id` index —
 * so it was a full scan of the table, cross-org, on a timer.
 *
 * Partial on the sweeper's exact predicate (Super Agent, In Review, not
 * dismissed) so the index stays tiny — it holds only the cards currently parked
 * — and ordered by the keyset cursor `(updated_at, id)` so the paged scan reads
 * straight off it.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  // Raw SQL: Kysely's index builder has no partial-index predicate.
  await sql`
    CREATE INDEX idx_task_board_items_pending_review
      ON task_board_items (updated_at, id)
      WHERE status = 'in_review'
        AND assignee_id = 'super-agent'
        AND dismissed_at IS NULL
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropIndex("idx_task_board_items_pending_review").execute();
}
