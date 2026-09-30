/**
 * Forum topics are task cards that belong to a project (a forum channel).
 *
 * `task_board_items.project_id` names the channel. It is nullable because an
 * ordinary board card belongs to no forum; the index serves the channel list,
 * which always reads one org's cards by project.
 *
 * `task_board_item_votes` holds one row per (card, user): the primary key is
 * what makes a vote a toggle rather than a counter anyone can inflate.
 */
import { type Kysely, sql } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .alterTable("task_board_items")
    .addColumn("project_id", "text")
    .execute();

  await db.schema
    .createIndex("task_board_items_org_project_idx")
    .on("task_board_items")
    .columns(["organization_id", "project_id"])
    .where(sql.ref("project_id"), "is not", null)
    .execute();

  await db.schema
    .createTable("task_board_item_votes")
    .addColumn("task_board_item_id", "text", (col) =>
      col.notNull().references("task_board_items.id").onDelete("cascade"),
    )
    .addColumn("user_id", "text", (col) => col.notNull())
    .addColumn("created_at", "timestamptz", (col) =>
      col.notNull().defaultTo(sql`now()`),
    )
    .addPrimaryKeyConstraint("task_board_item_votes_pk", [
      "task_board_item_id",
      "user_id",
    ])
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable("task_board_item_votes").execute();
  await db.schema.dropIndex("task_board_items_org_project_idx").execute();
  await db.schema
    .alterTable("task_board_items")
    .dropColumn("project_id")
    .execute();
}
