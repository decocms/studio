import type { Kysely } from "kysely";

/**
 * Dismissing a reports-pushed card — what makes deleting it stick.
 *
 * The import identifies a finding by `task_board_items.external_key` and
 * refreshes the matching OPEN card instead of duplicating it (migration 136).
 * A hard-deleted card matches nothing, so the next diagnostic run for the same
 * domain re-creates it — deleting a finding would silently undo itself.
 *
 * So a finding's card isn't deleted, it's dismissed: the row stays, off the
 * board, and the import skips its key. That keeps the card's comments,
 * activity, linked threads and quota claim intact, so restoring it brings back
 * the same card rather than a fresh one — and it keeps
 * `task_quota_claims.task_board_item_id`'s ON DELETE CASCADE (migration 160)
 * unreachable for reports tasks, which is what stops "delete the card" from
 * becoming a quota refund.
 *
 * Who dismissed it is `updated_by` — a dismissed card takes no further writes
 * (the import skips it), so that column is the dismisser until it's restored.
 *
 * Human-created cards have `external_key = null` and are still hard-deleted.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .alterTable("task_board_items")
    .addColumn("dismissed_at", "timestamptz")
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .alterTable("task_board_items")
    .dropColumn("dismissed_at")
    .execute();
}
