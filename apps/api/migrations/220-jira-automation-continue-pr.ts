import type { Kysely } from "kysely";

/**
 * A Jira status rule can say "continue the pull request the issue already
 * carries". Off, every run the rule starts works on a fresh branch and opens
 * a new pull request — right for a first implementation, wrong for a card a
 * reviewer sent back, which then collects a second pull request for the same
 * change. On, the trigger resolves the issue's open pull requests from its web
 * links before dispatch and pins the run to the first one's branch; an issue
 * with none still starts fresh.
 *
 * Per rule, not inferred from the transition: a review column must never pin
 * its run to the pull request it is about to judge.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .alterTable("org_jira_column_automations")
    .addColumn("continue_pr", "boolean", (col) =>
      col.notNull().defaultTo(false),
    )
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .alterTable("org_jira_column_automations")
    .dropColumn("continue_pr")
    .execute();
}
