import { type Kysely, sql } from "kysely";

/**
 * `board_pr_ready` triggers read `column_key` to name the lane they watch
 * (see `automations.ts`'s `board_triggers` aggregation), same as
 * `board_column_transition` and `jira_transition`. Those two got a CHECK
 * constraint requiring it (migrations 241, 247); this type was added in 246
 * without one.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    ALTER TABLE automation_triggers
      ADD CONSTRAINT chk_board_pr_ready_trigger CHECK (
        type != 'board_pr_ready' OR column_key IS NOT NULL
      )
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`
    ALTER TABLE automation_triggers
      DROP CONSTRAINT IF EXISTS chk_board_pr_ready_trigger
  `.execute(db);
}
