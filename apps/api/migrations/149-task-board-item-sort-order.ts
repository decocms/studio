import { sql, type Kysely } from "kysely";

/**
 * Manual drag-to-reorder within a lane. Ascending `sort_order` is the lane's
 * display order; existing rows are backfilled to `-created_at` (in seconds)
 * so the initial order matches the prior `created_at desc` behavior.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .alterTable("task_board_items")
    .addColumn("sort_order", "double precision", (col) =>
      col.notNull().defaultTo(0),
    )
    .execute();

  await sql`
    update task_board_items
    set sort_order = -extract(epoch from created_at)
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .alterTable("task_board_items")
    .dropColumn("sort_order")
    .execute();
}
