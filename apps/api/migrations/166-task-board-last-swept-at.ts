import { type Kysely, sql } from "kysely";

/**
 * When a card was last reconciled by the review sweeper.
 *
 * The sweeper's rate was a product of its own timer (`setInterval`, per pod)
 * rather than of anything about the cards, and that had two consequences in
 * prod, both measured: every API replica ran its own timer over the same work
 * list, so the GitHub cost was multiplied by the replica count; and a card whose
 * checks never go green never leaves `listItemsPendingReview`, so it was
 * re-fetched every 60s forever. 32 such cards in one org held a steady ~370
 * `pull_request_read` calls/min for 17 hours and exhausted the GitHub App's
 * installation rate limit (93% of the calls came back 429).
 *
 * Stamping the interval on the CARD instead of the pod fixes both with one
 * mechanism: replicas share the stamp, so a card is swept once per interval no
 * matter how many pods are running, and a permanently-parked card costs one
 * sweep per interval instead of one per tick. It also stays correct if the
 * replica count changes, which a leader lock would not.
 *
 * NULL means never swept — those sort first and are always due, so existing
 * cards are picked up on the next tick with no backfill.
 *
 * Deliberately NOT `updated_at`: a sweep is not a user-visible edit, and reusing
 * `updated_at` would churn the keyset cursor this table is paged by and make
 * every parked card look freshly edited in the UI.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    ALTER TABLE task_board_items
      ADD COLUMN last_swept_at timestamptz
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`
    ALTER TABLE task_board_items
      DROP COLUMN last_swept_at
  `.execute(db);
}
