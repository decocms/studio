import { sql, type Kysely } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable("task_board_read_markers")
    .addColumn("user_id", "text", (c) =>
      c.notNull().references("user.id").onDelete("cascade"),
    )
    .addColumn("task_board_item_id", "text", (c) =>
      c.notNull().references("task_board_items.id").onDelete("cascade"),
    )
    .addColumn("comment_created_at", "timestamptz", (c) => c.notNull())
    .addColumn("comment_id", "text", (c) => c.notNull())
    .addPrimaryKeyConstraint("task_board_read_markers_pk", [
      "user_id",
      "task_board_item_id",
    ])
    .execute();
  await sql`CREATE INDEX task_board_comments_forum ON task_board_comments (task_board_item_id, created_at DESC, id DESC)`.execute(
    db,
  );
  await sql`CREATE INDEX notifications_task_unread ON notifications (organization_id, user_id, task_board_item_id, created_at DESC) WHERE read_at IS NULL`.execute(
    db,
  );
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropIndex("notifications_task_unread").execute();
  await db.schema.dropIndex("task_board_comments_forum").execute();
  await db.schema.dropTable("task_board_read_markers").execute();
}
