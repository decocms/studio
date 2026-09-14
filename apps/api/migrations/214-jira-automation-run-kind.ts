import { type Kysely, sql } from "kysely";

/**
 * What a Jira status rule asks the run to DO.
 *
 * A column rule used to have one shape — implement the issue and open a pull
 * request — because the first runs were fired by hand, one thread doing the
 * work and reviewing itself. That is the exception. The process the rules
 * replace is two columns and two runs: one implements and hands over, a second
 * reviews the pull request and runs QA on the deploy preview, and the two need
 * opposite closing instructions (the reviewer must NOT open a second pull
 * request, and its verdict is the transition it makes).
 *
 * `execute` is the existing behaviour, so every rule already stored is one.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    ALTER TABLE org_jira_column_automations
      ADD COLUMN IF NOT EXISTS run_kind text NOT NULL DEFAULT 'execute'
      CONSTRAINT chk_org_jira_column_automations_run_kind
        CHECK (run_kind IN ('execute', 'review'))
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`
    ALTER TABLE org_jira_column_automations DROP COLUMN IF EXISTS run_kind
  `.execute(db);
}
