import type { Kysely } from "kysely";

/**
 * The paths a task's work created or edited, so the card's "Open preview"
 * button can offer the actual pages instead of only the preview root.
 *
 * A column rather than something read back out of the pull request body: the
 * body is prose an agent writes and a human then edits, and the first version
 * of this feature parsed it — one hand-edited body was enough to lose the
 * routes with nothing to debug. Written by `TASK_BOARD_ITEM_UPDATE`, so the
 * value is a validated array that arrives once and is never re-derived.
 *
 * Per task, not per pull request: a task is the working item, and in practice
 * carries one PR. A multi-repo task shows its routes under each PR's button.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .alterTable("task_board_items")
    .addColumn("preview_routes", "jsonb")
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .alterTable("task_board_items")
    .dropColumn("preview_routes")
    .execute();
}
