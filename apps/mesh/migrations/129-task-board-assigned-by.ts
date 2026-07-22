import { type Kysely } from "kysely";

/**
 * Adds `assigned_by` (nullable) to `task_board_items` — the userId of whoever
 * set the current assignee. Records the delegation link (who → whom), so a
 * task delegated to the Super Agent can show "assigned by <user>".
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .alterTable("task_board_items")
    .addColumn("assigned_by", "text")
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .alterTable("task_board_items")
    .dropColumn("assigned_by")
    .execute();
}
