import type { Kysely } from "kysely";

/**
 * Which run thread wrote a comment, when an agent run did.
 *
 * Every agent comment is authored by the same synthetic `SUPER_AGENT_ASSIGNEE_ID`,
 * so until now there was no way to tell the QA Agent's comment from the Code
 * Reviewer's from the Super Agent's — which is exactly what "did THIS reviewer
 * record its pass?" needs to know. Null for a human's comment and for every
 * comment written before this column existed.
 *
 * No FK to `threads`: a comment outlives the run that wrote it, and a deleted
 * thread must not cascade a review record away.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .alterTable("task_board_comments")
    .addColumn("thread_id", "text")
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .alterTable("task_board_comments")
    .dropColumn("thread_id")
    .execute();
}
