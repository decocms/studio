import { type Kysely } from "kysely";

/**
 * Task board items can pertain to a specific repo (site), so the task-based
 * flow can scope a site's tasks to it. Nullable — org-wide tasks (no site
 * context) carry none.
 *
 * One column holding `owner/name`, not an owner/name pair: the value is only
 * ever written whole (from a repo-scoped connection's scope), and two nullable
 * columns let a partial update leave a half-named repo behind.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .alterTable("task_board_items")
    .addColumn("repo", "text")
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.alterTable("task_board_items").dropColumn("repo").execute();
}
