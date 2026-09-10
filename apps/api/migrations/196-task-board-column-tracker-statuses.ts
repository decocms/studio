import { type Kysely, sql } from "kysely";

/**
 * The tracker statuses a mirrored column groups, in the order the tracker
 * declares them.
 *
 * A Jira board column is not a status: it is a bucket of them, and real boards
 * use that. One customer's five columns cover ten statuses, with three in a
 * single column.
 *
 * The pull never needed this — an issue has one status, the status sits in one
 * column, so the card's lane is decided. The PUSH cannot move without it. "The
 * card is in Em andamento" does not say whether the issue becomes `Em
 * andamento`, `In Progress` or `Desenvolvimento`, and the answer is whichever
 * the issue's workflow can reach right now. That is what the hand-written
 * status mapping was for; this column is the same list, read from the board
 * instead of typed by a person.
 *
 * Empty for Studio's own columns, which are constants and mirror nothing.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .alterTable("task_board_columns")
    .addColumn("tracker_statuses", "jsonb", (col) =>
      col.notNull().defaultTo(sql`'[]'::jsonb`),
    )
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .alterTable("task_board_columns")
    .dropColumn("tracker_statuses")
    .execute();
}
