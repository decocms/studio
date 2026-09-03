import { type Kysely, sql } from "kysely";

/**
 * The Jira integration as a run trigger.
 *
 * An issue entering a Jira status that has a rule starts an agent run. The run
 * is anchored on a board item (`source = 'jira'`) so quota, pull requests,
 * review and rerun keep working, but that item is not a card the board shows —
 * the issue's home is Jira, and the item carries no copy of it.
 *
 * - `org_jira_column_automations`: the rule per Jira status — row existence is
 *   the switch, `prompt` null means the agent's own instruction. Keyed by the
 *   STATUS name, not the column: a Jira column is a bucket of statuses and the
 *   webhook reports the status.
 * - `jira_trigger_claims`: one row per (issue, changelog entry) — the fence
 *   that keeps a redelivered webhook or the safety-net poll from dispatching a
 *   second paid run for the same transition.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    ALTER TABLE task_board_items
      ADD COLUMN IF NOT EXISTS source text
      CONSTRAINT chk_task_board_items_source CHECK (source IN ('jira'))
  `.execute(db);
  await sql`
    CREATE TABLE IF NOT EXISTS org_jira_column_automations (
      organization_id text NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
      jira_status text NOT NULL,
      prompt text,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (organization_id, jira_status)
    )
  `.execute(db);
  await sql`
    CREATE TABLE IF NOT EXISTS jira_trigger_claims (
      organization_id text NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
      jira_issue_id text NOT NULL,
      changelog_id text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (organization_id, jira_issue_id, changelog_id)
    )
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP TABLE IF EXISTS jira_trigger_claims`.execute(db);
  await sql`DROP TABLE IF EXISTS org_jira_column_automations`.execute(db);
  await sql`ALTER TABLE task_board_items DROP COLUMN IF EXISTS source`.execute(
    db,
  );
}
