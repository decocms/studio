import { type Kysely, sql } from "kysely";

/**
 * A quota claim must outlive the card it was charged for.
 *
 * `task_quota_claims.task_board_item_id` referenced `task_board_items` with
 * ON DELETE CASCADE (migration 160). That was unreachable while reports-pushed
 * tasks — the only ones the quota charges — couldn't be deleted. Now that they
 * can be (migration 163), the cascade would turn "delete the card" into a
 * refund: delegate a task to the Super Agent, delete it, and the period's slot
 * frees up again. Repeat for unlimited subsidized runs.
 *
 * A refund has exactly one writer and one meaning already — `state =
 * 'released'`, set only when a run demonstrably produced nothing (migration
 * 161). Dropping the FK makes the claim an append-only ledger: deleting a card
 * forgets the card, never the charge. Orphaned claims still leave with their
 * org (`organization_id` keeps its cascade) and still count toward the period,
 * which is the point.
 *
 * The PK stays — one claim per task id, and `taskClaim(id)` still looks up by
 * it. A restored finding is re-imported as a NEW task id, so it gets its own
 * claim rather than inheriting the deleted one's `run_count`.
 *
 * down() restores the cascade, which re-opens the refund-by-delete hole. It
 * first deletes claims whose task is gone, since the FK can't be re-added
 * while they exist.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    alter table task_quota_claims
      drop constraint task_quota_claims_task_board_item_id_fkey
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`
    delete from task_quota_claims c
      where not exists (
        select 1 from task_board_items i where i.id = c.task_board_item_id
      )
  `.execute(db);
  await sql`
    alter table task_quota_claims
      add constraint task_quota_claims_task_board_item_id_fkey
      foreign key (task_board_item_id) references task_board_items(id)
      on delete cascade
  `.execute(db);
}
