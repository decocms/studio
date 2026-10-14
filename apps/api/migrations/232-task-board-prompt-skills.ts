import { type Kysely, sql } from "kysely";

/** Skills per board prompt scope; `prompt` may now be empty when skills are set. */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    ALTER TABLE task_board_prompts
      ADD COLUMN IF NOT EXISTS skills text[] NOT NULL DEFAULT '{}'
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DELETE FROM task_board_prompts WHERE prompt = ''`.execute(db);
  await sql`ALTER TABLE task_board_prompts DROP COLUMN skills`.execute(db);
}
