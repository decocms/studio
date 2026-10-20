import { type Kysely, sql } from "kysely";

/**
 * The project a card belongs to (`task_board_items.virtual_mcp_id`).
 *
 * `repo` cannot say it: several projects may pin one repository, and a card
 * carrying only that repository counted for all of them. `repo` and
 * `repository_id` stay what a run checks out; this column only attributes.
 *
 * Nullable with no backfill: an unstamped card keeps today's attribution. A
 * deleted project releases its cards rather than deleting them. The partial
 * index serves that `ON DELETE SET NULL`, which would otherwise scan the table
 * on every project delete.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    ALTER TABLE task_board_items
      ADD COLUMN IF NOT EXISTS virtual_mcp_id text NULL
        REFERENCES connections(id) ON DELETE SET NULL
  `.execute(db);
  await sql`
    CREATE INDEX IF NOT EXISTS idx_task_board_items_virtual_mcp_id
      ON task_board_items (virtual_mcp_id)
      WHERE virtual_mcp_id IS NOT NULL
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP INDEX IF EXISTS idx_task_board_items_virtual_mcp_id`.execute(
    db,
  );
  await sql`ALTER TABLE task_board_items DROP COLUMN IF EXISTS virtual_mcp_id`.execute(
    db,
  );
}
