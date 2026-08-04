import type { Kysely } from "kysely";

/**
 * Hold-and-commit for task-quota claims (billing/task-quota.ts): a dispatch
 * takes a HOLD, and the charge only COMMITS when the run produces a pull
 * request (the task reaching In Review). A run that ends without one is
 * RELEASED — the org gets the slot back instead of paying for nothing.
 *
 * `released` rows stop counting toward the period limit but keep their
 * `run_count`, so releasing can never be used as a free reset: the per-task
 * execution cap still bounds how many times one task may be re-dispatched.
 *
 * Pre-existing claims backfill to `committed`: they were charged under the
 * old dispatch-time semantics and must not be retroactively refunded.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .alterTable("task_quota_claims")
    .addColumn("state", "text", (col) => col.notNull().defaultTo("committed"))
    .execute();
  await db.schema
    .createIndex("idx_task_quota_claims_org_period_state")
    .on("task_quota_claims")
    .columns(["organization_id", "period_key", "state"])
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .dropIndex("idx_task_quota_claims_org_period_state")
    .ifExists()
    .execute();
  await db.schema.alterTable("task_quota_claims").dropColumn("state").execute();
}
