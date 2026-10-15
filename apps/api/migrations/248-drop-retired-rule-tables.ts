import { type Kysely, sql } from "kysely";

/**
 * Drop the two rule tables automations replaced:
 * - `task_board_column_automations`, the board column's "Run the agent" rule,
 *   replaced by the built-in Implementer (migration 245);
 * - `org_jira_column_automations`, the Jira status rules, copied into
 *   automations with a `jira_transition` trigger (migration 247).
 *
 * Nothing has read either table since. `down` restores them empty.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`DROP TABLE IF EXISTS task_board_column_automations`.execute(db);
  await sql`DROP TABLE IF EXISTS org_jira_column_automations`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`
    CREATE TABLE IF NOT EXISTS task_board_column_automations (
      id text PRIMARY KEY,
      organization_id text NOT NULL,
      column_key text NOT NULL,
      prompt text,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    )
  `.execute(db);
  await sql`
    CREATE UNIQUE INDEX IF NOT EXISTS task_board_column_automations_org_column_uniq
      ON task_board_column_automations (organization_id, column_key)
  `.execute(db);
  await sql`
    CREATE TABLE IF NOT EXISTS org_jira_column_automations (
      organization_id text NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
      jira_status text NOT NULL,
      prompt text,
      continue_pr boolean NOT NULL DEFAULT false,
      from_kind text NOT NULL DEFAULT 'any'
        CONSTRAINT chk_org_jira_column_automations_from_kind
        CHECK (from_kind IN ('any', 'earlier', 'later', 'statuses')),
      from_statuses text[] NOT NULL DEFAULT '{}',
      from_key text NOT NULL DEFAULT 'any',
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (organization_id, jira_status, from_key)
    )
  `.execute(db);
}
