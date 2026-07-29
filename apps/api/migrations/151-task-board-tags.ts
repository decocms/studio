import { type Kysely, sql } from "kysely";

/**
 * Tags on task board items. Reuses `organization_tags` (previously
 * member-only) as the org-wide tag pool, adding a `color` column so a tag
 * renders a dot like priority does. `task_board_item_tags` is the
 * many-to-many join, mirroring `task_board_item_threads`.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .alterTable("organization_tags")
    .addColumn("color", "text")
    .execute();

  await db.schema
    .createTable("task_board_item_tags")
    .addColumn("task_board_item_id", "text", (col) =>
      col.notNull().references("task_board_items.id").onDelete("cascade"),
    )
    .addColumn("tag_id", "text", (col) =>
      col.notNull().references("organization_tags.id").onDelete("cascade"),
    )
    .addColumn("organization_id", "text", (col) =>
      col.notNull().references("organization.id").onDelete("cascade"),
    )
    .addColumn("created_at", "timestamptz", (col) =>
      col.notNull().defaultTo(sql`now()`),
    )
    .execute();

  await db.schema
    .createIndex("idx_task_board_item_tags_unique")
    .on("task_board_item_tags")
    .columns(["task_board_item_id", "tag_id"])
    .unique()
    .execute();

  await db.schema
    .createIndex("idx_task_board_item_tags_tag")
    .on("task_board_item_tags")
    .columns(["tag_id"])
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropIndex("idx_task_board_item_tags_tag").execute();
  await db.schema.dropIndex("idx_task_board_item_tags_unique").execute();
  await db.schema.dropTable("task_board_item_tags").execute();
  await db.schema.alterTable("organization_tags").dropColumn("color").execute();
}
