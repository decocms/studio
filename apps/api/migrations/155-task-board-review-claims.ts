import { type Kysely, sql } from "kysely";

/**
 * Review claims — one row per (task, reviewer, review-cycle). Serves two jobs:
 *
 *  1. **Idempotent dispatch.** A reviewer run is enqueued from two places (the
 *     projector run-terminal hook and the modal's poll), which can race. The
 *     primary key makes the claim an atomic `INSERT … ON CONFLICT DO NOTHING`:
 *     the loser skips, so exactly one QA / Code Reviewer run spawns per cycle.
 *
 *  2. **Reviewer-identity binding.** Each claim mints a random `token` handed to
 *     that reviewer run in its prompt. When the reviewer records its decision it
 *     passes the token back; the decision tool resolves the token → claim to
 *     confirm the caller really is that reviewer. Without this, the `reviewer`
 *     field is self-asserted and one agent could forge the "both reviewers
 *     approved" gate to trigger auto-merge.
 *
 * `cycle_at` is the timestamp the task entered In Review for this cycle, so a
 * re-review (fix pushed to the same PR → back to In Review) mints a fresh claim
 * and lets the reviewers run again.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable("task_board_review_claims")
    .addColumn("task_board_item_id", "text", (col) =>
      col.notNull().references("task_board_items.id").onDelete("cascade"),
    )
    .addColumn("reviewer", "text", (col) => col.notNull())
    .addColumn("cycle_at", "timestamptz", (col) => col.notNull())
    .addColumn("token", "text", (col) => col.notNull())
    .addColumn("created_at", "timestamptz", (col) =>
      col.notNull().defaultTo(sql`now()`),
    )
    .addPrimaryKeyConstraint("task_board_review_claims_pkey", [
      "task_board_item_id",
      "reviewer",
      "cycle_at",
    ])
    .execute();

  await db.schema
    .createIndex("idx_task_board_review_claims_token")
    .on("task_board_review_claims")
    .columns(["task_board_item_id", "token"])
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropIndex("idx_task_board_review_claims_token").execute();
  await db.schema.dropTable("task_board_review_claims").execute();
}
