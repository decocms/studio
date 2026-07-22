import type { Kysely } from "kysely";

/**
 * `task_board_item_threads.thread_id` had no FK back to `threads` (migration
 * 130), so deleting a thread left an orphaned link row forever — the row is
 * filtered out by the board's inner join but never cleaned up. Add the same
 * ON DELETE CASCADE convention used by every other threads-referencing table
 * (021, 098, 102).
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .alterTable("task_board_item_threads")
    .addForeignKeyConstraint(
      "task_board_item_threads_thread_id_fkey",
      ["thread_id"],
      "threads",
      ["id"],
      (cb) => cb.onDelete("cascade"),
    )
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .alterTable("task_board_item_threads")
    .dropConstraint("task_board_item_threads_thread_id_fkey")
    .execute();
}
