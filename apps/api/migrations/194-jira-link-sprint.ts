import type { Kysely } from "kysely";

/**
 * Records the sprint a linked issue was last SEEN OR SET in on the Jira side,
 * so sprint can be two-way the way status already is.
 *
 * Until now the sync was the only writer of a card's sprint, so overwriting it
 * on every pull lost nothing. The moment a person can move a card between the
 * backlog and a sprint from Studio, that unguarded overwrite is data loss: the
 * next tick reads Jira's unchanged sprint and undoes the move.
 *
 * Same shape and same job as `jira_status`. The pull applies sprint only when
 * this changed, and the push records its target here so the echo is a no-op.
 *
 * Nullable with no backfill, and that is safe rather than lucky: null reads as
 * "no sprint", so the first pull after this rewrites the sprint of every card
 * whose issue IS in one and skips every card whose issue is not. Both land on
 * what the unconditional pull had already written, because until now the sync
 * was the only writer there was.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .alterTable("task_board_item_jira_links")
    .addColumn("jira_sprint_id", "text")
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .alterTable("task_board_item_jira_links")
    .dropColumn("jira_sprint_id")
    .execute();
}
