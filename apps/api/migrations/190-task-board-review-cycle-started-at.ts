import { type Kysely, sql } from "kysely";

/**
 * Decouple the review cycle from the board lane.
 *
 * The "current review cycle" — the boundary that decides which reviewer
 * verdicts still count — used to be derived from the newest
 * `status_changed → in_review` activity, i.e. from the LANE the card sits in.
 * That made the lane load-bearing: a card could not be anywhere but In Review
 * while its reviewer ran, because moving it would have reset the cycle and
 * invalidated every verdict recorded before the move.
 *
 * `review_cycle_started_at` is that boundary as its own column. With it, the
 * lane is free to say what a human actually wants to read — In Progress while
 * an agent reviewer is still working, In Review once it is a person's turn —
 * and the reviewer machinery keys on the column instead.
 *
 * Backfilled from the timeline so in-flight cycles survive the deploy:
 * `reviewCycleStart` still falls back to the activity scan for a card that has
 * neither (see `packages/shared/src/task-board.ts`), so a missed row degrades
 * to the old behaviour rather than to a lost cycle.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .alterTable("task_board_items")
    .addColumn("review_cycle_started_at", "timestamptz")
    .execute();

  // Every card whose current lane means "a review cycle is open", anchored on
  // the transition that opened it.
  await sql`
    UPDATE task_board_items i
       SET review_cycle_started_at = (
             SELECT max(a.occurred_at)
               FROM task_board_activity a
              WHERE a.task_board_item_id = i.id
                AND a.action = 'status_changed'
                AND a.data ->> 'to' = 'in_review'
           )
     WHERE i.status = 'in_review'
  `.execute(db);

  // Replaces idx_task_board_items_pending_review: the sweeper's work list is no
  // longer "cards in the In Review lane" but "cards with an open review cycle",
  // which spans In Progress and In Review.
  await sql`
    CREATE INDEX idx_task_board_items_review_cycle
      ON task_board_items (updated_at, id)
      WHERE (review_cycle_started_at IS NOT NULL OR status = 'in_review')
        AND assignee_id = 'super-agent'
        AND dismissed_at IS NULL
  `.execute(db);
  await sql`DROP INDEX IF EXISTS idx_task_board_items_pending_review`.execute(
    db,
  );
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`
    CREATE INDEX idx_task_board_items_pending_review
      ON task_board_items (updated_at, id)
      WHERE status = 'in_review'
        AND assignee_id = 'super-agent'
        AND dismissed_at IS NULL
  `.execute(db);
  await sql`DROP INDEX IF EXISTS idx_task_board_items_review_cycle`.execute(db);
  await db.schema
    .alterTable("task_board_items")
    .dropColumn("review_cycle_started_at")
    .execute();
}
