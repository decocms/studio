import { type Kysely, sql } from "kysely";

/**
 * Drop `org_jira_integrations.jql_filter`.
 *
 * It existed to let a tenant hand-write the rest of their board's saved filter,
 * because migration 171 scoped the pull by board-CARD membership and had no
 * other way to express "and also these labels". Migration 182 made the board's
 * own filter the scope, so the field's whole job is done automatically — what
 * is left is a way to narrow the pull further, which nothing has ever used.
 *
 * Not merely unused: as an escape hatch it was actively dangerous. Its own
 * placeholder suggested `sprint in openSprints()`, and a tenant who took that
 * suggestion would have re-excluded the board's backlog by hand, silently
 * undoing 182's fix on exactly the boards it was written for.
 *
 * No column in production held a value when this ran.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .alterTable("org_jira_integrations")
    .dropColumn("jql_filter")
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`ALTER TABLE org_jira_integrations ADD COLUMN jql_filter text`.execute(
    db,
  );
}
