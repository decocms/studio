import { type Kysely, sql } from "kysely";

/**
 * Comments on a task — threads in the task dialog's activity feed, with one
 * level of replies (`parent_id` NULL = thread root, a reply's parent is always
 * a root). `resolved` is a thread property, so it only ever matters on a root.
 *
 * Both FKs cascade: deleting a task takes its comments, deleting a root takes
 * its replies — a conversation with no opening line reads as nothing.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable("task_board_comments")
    .addColumn("id", "text", (col) => col.primaryKey())
    .addColumn("task_board_item_id", "text", (col) =>
      col.notNull().references("task_board_items.id").onDelete("cascade"),
    )
    .addColumn("parent_id", "text", (col) =>
      col.references("task_board_comments.id").onDelete("cascade"),
    )
    .addColumn("author_id", "text", (col) => col.notNull())
    .addColumn("body", "text", (col) => col.notNull())
    .addColumn("resolved", "boolean", (col) => col.notNull().defaultTo(false))
    .addColumn("created_at", "timestamptz", (col) =>
      col.notNull().defaultTo(sql`now()`),
    )
    .addColumn("updated_at", "timestamptz", (col) =>
      col.notNull().defaultTo(sql`now()`),
    )
    .execute();

  await db.schema
    .createIndex("idx_task_board_comments_item")
    .on("task_board_comments")
    .columns(["task_board_item_id", "created_at"])
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropIndex("idx_task_board_comments_item").execute();
  await db.schema.dropTable("task_board_comments").execute();
}
