import { type Kysely, sql } from "kysely";

/**
 * Every card names its board.
 *
 * Migration 258 filed the cards that existed then, and the release that ran it
 * files every card it creates. What it left are the cards a release without
 * `board_id` created during that rollout; they go to the development board of
 * their project, or of their organization, and the column becomes NOT NULL.
 *
 * Must ship in a release after 258's: the release before 258 inserts cards
 * without the column.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    INSERT INTO task_boards (id, organization_id, virtual_mcp_id, type)
    SELECT 'tboard_' || replace(gen_random_uuid()::text, '-', ''),
           s.organization_id, s.virtual_mcp_id, 'development'
      FROM (
        SELECT DISTINCT organization_id, virtual_mcp_id
          FROM task_board_items
         WHERE board_id IS NULL
      ) s
    ON CONFLICT (organization_id, virtual_mcp_id, type) DO NOTHING
  `.execute(db);
  await sql`
    UPDATE task_board_items i
       SET board_id = b.id
      FROM task_boards b
     WHERE b.organization_id = i.organization_id
       AND b.virtual_mcp_id IS NOT DISTINCT FROM i.virtual_mcp_id
       AND b.type = 'development'
       AND i.board_id IS NULL
  `.execute(db);
  await sql`
    ALTER TABLE task_board_items ALTER COLUMN board_id SET NOT NULL
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`
    ALTER TABLE task_board_items ALTER COLUMN board_id DROP NOT NULL
  `.execute(db);
}
