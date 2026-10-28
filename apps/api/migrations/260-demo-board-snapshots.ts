import type { Kysely } from "kysely";

/**
 * The task board a curated demo org returns to every day: the rows of its
 * captured cards and their runs, plus how the last reset went.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable("demo_board_snapshots")
    .ifNotExists()
    .addColumn("organization_id", "text", (col) =>
      col.primaryKey().references("organization.id").onDelete("cascade"),
    )
    .addColumn("snapshot", "jsonb", (col) => col.notNull())
    // Read on every board sweep and card open, so kept out of `snapshot`.
    .addColumn("frozen_item_ids", "jsonb", (col) => col.notNull())
    .addColumn("pr_cards", "jsonb", (col) => col.notNull())
    .addColumn("captured_at", "timestamptz", (col) => col.notNull())
    .addColumn("captured_by", "text", (col) => col.notNull())
    .addColumn("last_reset_at", "timestamptz")
    .addColumn("last_reset_error", "text")
    .addColumn("dead_preview_urls", "jsonb")
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable("demo_board_snapshots").ifExists().execute();
}
