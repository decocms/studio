import { type Kysely, sql } from "kysely";

/**
 * Boards as their own rows: one per pipeline type, per project or for the
 * organization itself.
 *
 * Until now "the board" was the organization: every card, column automation,
 * prompt and sprint hung off `organization_id`, and a card named its project
 * with `virtual_mcp_id`. A board is now `(organization, project, type)`, where
 * a null project is the organization's own board and `type` is one of the
 * pipelines defined in code (`BOARD_TYPES`). Each scope has at most one board
 * of a type. Every card is filed under one with `task_board_items.board_id`.
 *
 * Every organization gets its `development` board, and every project that has
 * cards gets one too. A card goes to the `development` board of its project,
 * or of its organization when it has none, so nothing reads differently yet.
 *
 * The foreign keys carry the organization: a board's project and a card's
 * board must belong to the same organization as the row pointing at them.
 * A null project skips the check, which is what lets the organization's own
 * board exist. `connections` gets a unique `(organization_id, id)` for that.
 *
 * Deleting a project deletes its boards; the code that deletes a project
 * moves their cards to the organization's board of the same type first, and
 * the foreign key from the card refuses the delete otherwise.
 *
 * `board_id` stays nullable: a release without this column keeps creating
 * cards during a rollout, and those land with no board. A later migration
 * files them and makes the column NOT NULL once no such release runs.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    CREATE UNIQUE INDEX IF NOT EXISTS uq_connections_organization_id_id
      ON connections (organization_id, id)
  `.execute(db);
  await sql`
    CREATE TABLE IF NOT EXISTS task_boards (
      id text PRIMARY KEY,
      organization_id text NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
      virtual_mcp_id text NULL,
      type text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT uq_task_boards_organization_id_id UNIQUE (organization_id, id),
      CONSTRAINT uq_task_boards_scope_type
        UNIQUE NULLS NOT DISTINCT (organization_id, virtual_mcp_id, type),
      CONSTRAINT fk_task_boards_project
        FOREIGN KEY (organization_id, virtual_mcp_id)
        REFERENCES connections (organization_id, id) ON DELETE CASCADE
    )
  `.execute(db);
  await sql`
    CREATE INDEX IF NOT EXISTS idx_task_boards_virtual_mcp_id
      ON task_boards (virtual_mcp_id)
      WHERE virtual_mcp_id IS NOT NULL
  `.execute(db);

  await sql`
    ALTER TABLE task_board_items ADD COLUMN IF NOT EXISTS board_id text NULL
  `.execute(db);
  await sql`
    ALTER TABLE task_board_items
      DROP CONSTRAINT IF EXISTS fk_task_board_items_board,
      ADD CONSTRAINT fk_task_board_items_board
        FOREIGN KEY (organization_id, board_id)
        REFERENCES task_boards (organization_id, id)
  `.execute(db);
  await sql`
    CREATE INDEX IF NOT EXISTS idx_task_board_items_board_id
      ON task_board_items (board_id)
  `.execute(db);

  await sql`
    INSERT INTO task_boards (id, organization_id, virtual_mcp_id, type)
    SELECT 'tboard_' || replace(gen_random_uuid()::text, '-', ''), o.id, NULL,
           'development'
      FROM organization o
    ON CONFLICT (organization_id, virtual_mcp_id, type) DO NOTHING
  `.execute(db);
  await sql`
    INSERT INTO task_boards (id, organization_id, virtual_mcp_id, type)
    SELECT 'tboard_' || replace(gen_random_uuid()::text, '-', ''),
           p.organization_id, p.virtual_mcp_id, 'development'
      FROM (
        SELECT DISTINCT organization_id, virtual_mcp_id
          FROM task_board_items
         WHERE virtual_mcp_id IS NOT NULL
      ) p
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
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP INDEX IF EXISTS idx_task_board_items_board_id`.execute(db);
  await sql`ALTER TABLE task_board_items DROP COLUMN IF EXISTS board_id`.execute(
    db,
  );
  await sql`DROP TABLE IF EXISTS task_boards`.execute(db);
  await sql`DROP INDEX IF EXISTS uq_connections_organization_id_id`.execute(db);
}
