import { type Kysely, sql } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    ALTER TABLE task_board_items
    ADD COLUMN IF NOT EXISTS harness_id text NOT NULL DEFAULT 'claude-code'
      CHECK (harness_id IN ('claude-code', 'codex'))
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`ALTER TABLE task_board_items DROP COLUMN IF EXISTS harness_id`.execute(
    db,
  );
}
