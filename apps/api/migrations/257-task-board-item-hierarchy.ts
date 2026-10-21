import { type Kysely, sql } from "kysely";

/**
 * Epics and subtasks on the task board.
 *
 * `is_epic` marks a card as an epic. `parent_id` points at the card it sits
 * under: an epic (the card stays on the board) or another card (the card is
 * that card's subtask). The organization and nesting rules live in
 * `TaskBoardStorage`, since a plain foreign key cannot check them.
 *
 * Deleting a parent sets its children's `parent_id` to null so they return to
 * the board instead of pointing at nothing. The partial index serves that
 * `ON DELETE SET NULL` and the children lookups.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    ALTER TABLE task_board_items
      ADD COLUMN IF NOT EXISTS parent_id text NULL
        REFERENCES task_board_items(id) ON DELETE SET NULL,
      ADD COLUMN IF NOT EXISTS is_epic boolean NOT NULL DEFAULT false
  `.execute(db);
  await sql`
    CREATE INDEX IF NOT EXISTS idx_task_board_items_parent_id
      ON task_board_items (parent_id)
      WHERE parent_id IS NOT NULL
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP INDEX IF EXISTS idx_task_board_items_parent_id`.execute(db);
  await sql`
    ALTER TABLE task_board_items
      DROP COLUMN IF EXISTS parent_id,
      DROP COLUMN IF EXISTS is_epic
  `.execute(db);
}
