import type { Kysely } from "kysely";

/**
 * `task_board_item_threads.task_board_item_id` and
 * `task_board_item_prs.task_board_item_id` had no FK back to
 * `task_board_items` — deleting an org cascades away its `task_board_items`
 * rows (organization_id has ON DELETE CASCADE, migration 126) but leaves
 * these link rows orphaned forever, pointing at a task that no longer exists.
 * Same problem migration 131 fixed for `thread_id`; add the matching
 * cascade here.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .alterTable("task_board_item_threads")
    .addForeignKeyConstraint(
      "task_board_item_threads_task_board_item_id_fkey",
      ["task_board_item_id"],
      "task_board_items",
      ["id"],
      (cb) => cb.onDelete("cascade"),
    )
    .execute();

  await db.schema
    .alterTable("task_board_item_prs")
    .addForeignKeyConstraint(
      "task_board_item_prs_task_board_item_id_fkey",
      ["task_board_item_id"],
      "task_board_items",
      ["id"],
      (cb) => cb.onDelete("cascade"),
    )
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .alterTable("task_board_item_prs")
    .dropConstraint("task_board_item_prs_task_board_item_id_fkey")
    .execute();

  await db.schema
    .alterTable("task_board_item_threads")
    .dropConstraint("task_board_item_threads_task_board_item_id_fkey")
    .execute();
}
