/**
 * One row per (card, user) upvote on a forum topic. The primary key is what
 * makes a vote a toggle rather than a counter anyone can inflate; the cascade
 * drops a card's votes with the card.
 */
import { type Kysely, sql } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
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
}
