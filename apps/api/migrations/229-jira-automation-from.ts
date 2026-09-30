import { type Kysely, sql } from "kysely";

/**
 * A Jira status can carry several rules, told apart by where the card came
 * from: any origin, a column earlier or later on the board, or named
 * statuses. The implementing column then does one thing with a card arriving
 * from the backlog and another with one a reviewer or the client sent back,
 * instead of one prompt guessing which it got.
 *
 * `from_key` is the rule's identity within its status (`jira/rule-from.ts`):
 * the kind, or the lower-cased sorted list. It joins the primary key, so a
 * status keeps at most one rule per origin. Existing rules answer any origin.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    ALTER TABLE org_jira_column_automations
      ADD COLUMN IF NOT EXISTS from_kind text NOT NULL DEFAULT 'any'
        CONSTRAINT chk_org_jira_column_automations_from_kind
        CHECK (from_kind IN ('any', 'earlier', 'later', 'statuses')),
      ADD COLUMN IF NOT EXISTS from_statuses text[] NOT NULL DEFAULT '{}',
      ADD COLUMN IF NOT EXISTS from_key text NOT NULL DEFAULT 'any'
  `.execute(db);
  await sql`
    ALTER TABLE org_jira_column_automations
      DROP CONSTRAINT org_jira_column_automations_pkey,
      ADD PRIMARY KEY (organization_id, jira_status, from_key)
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  // The old key allows one rule per status: keep the any-origin one.
  await sql`
    DELETE FROM org_jira_column_automations WHERE from_key <> 'any'
  `.execute(db);
  await sql`
    ALTER TABLE org_jira_column_automations
      DROP CONSTRAINT org_jira_column_automations_pkey,
      ADD PRIMARY KEY (organization_id, jira_status),
      DROP COLUMN from_key,
      DROP COLUMN from_statuses,
      DROP COLUMN from_kind
  `.execute(db);
}
