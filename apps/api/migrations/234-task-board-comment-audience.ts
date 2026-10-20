import { type Kysely, sql } from "kysely";

/**
 * Who a task comment is written for. `internal` is agent-to-agent handoff (a
 * run's notes for the reviewer, the reviewer's technical pass) that the task
 * feed hides unless the reader opens the behind-the-scenes view; `human` is
 * everything a person reviewing the task reads.
 *
 * Defaults to `human` so a previous release, which never writes the column,
 * keeps every comment visible. Comments agents wrote before this column were
 * all handoff, so they start out internal.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .alterTable("task_board_comments")
    .addColumn("audience", "text", (col) =>
      col
        .notNull()
        .defaultTo("human")
        .check(sql`audience in ('human', 'internal')`),
    )
    .execute();

  await sql`update task_board_comments set audience = 'internal' where author_id = 'super-agent'`.execute(
    db,
  );
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .alterTable("task_board_comments")
    .dropColumn("audience")
    .execute();
}
