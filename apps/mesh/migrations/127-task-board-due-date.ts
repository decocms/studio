import { type Kysely } from "kysely";

/**
 * Adds `due_date` (nullable) to `task_board_items` so cards can carry an
 * explicit deadline instead of stuffing "Prazo: ..." into description text.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .alterTable("task_board_items")
    .addColumn("due_date", "timestamptz")
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .alterTable("task_board_items")
    .dropColumn("due_date")
    .execute();
}
