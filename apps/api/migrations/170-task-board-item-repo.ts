import { type Kysely } from "kysely";

/**
 * Task board items can pertain to a specific repo (site), so the task-based
 * flow can scope a site's tasks to it. Nullable — org-wide tasks (no site
 * context) carry neither.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .alterTable("task_board_items")
    .addColumn("repo_owner", "text")
    .addColumn("repo_name", "text")
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .alterTable("task_board_items")
    .dropColumn("repo_owner")
    .dropColumn("repo_name")
    .execute();
}
