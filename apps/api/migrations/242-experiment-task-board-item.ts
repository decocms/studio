import type { Kysely } from "kysely";

/**
 * The task board card an experiment's frontend implementation was delegated to.
 *
 * `EXPERIMENT_IMPLEMENT` already created that card and returned its id, but
 * nothing persisted the link — so the Experiments screen could never find the
 * pull request the Super Agent opened, nor the deploy preview that PR's CI
 * publishes, which is the whole "before / after" the tab exists to show. One
 * column rather than a join table: an experiment delegates to at most one card
 * (a re-delegation reuses it, or the same change forks a second pull request).
 *
 * NULL for every experiment created before this, and for one never delegated.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .alterTable("experiments")
    .addColumn("task_board_item_id", "text")
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .alterTable("experiments")
    .dropColumn("task_board_item_id")
    .execute();
}
