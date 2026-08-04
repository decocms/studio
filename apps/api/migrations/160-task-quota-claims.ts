import { type Kysely, sql } from "kysely";

/**
 * Quota ledger for reports-pushed task executions: one claim per task,
 * written the FIRST time a task is delegated to the Super Agent (re-runs —
 * review bounces, conflict resolutions — reuse the claim and are free).
 * `period_key` buckets the count without a cron: "trial" while the org has
 * no subscription in good standing, else the subscription's current period
 * end (refreshed by invoice.paid — the monthly clock).
 *
 * `run_count` bounds what one claim can spend: every dispatch of the task
 * increments it, and the claim stops authorizing runs past
 * STUDIO_MAX_RUNS_PER_TASK. Without it, re-delegating a claimed task in a
 * loop would buy unlimited subscription-billed runs off a single claim.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable("task_quota_claims")
    .addColumn("task_board_item_id", "text", (col) =>
      col.primaryKey().references("task_board_items.id").onDelete("cascade"),
    )
    .addColumn("organization_id", "text", (col) =>
      col.notNull().references("organization.id").onDelete("cascade"),
    )
    .addColumn("period_key", "text", (col) => col.notNull())
    .addColumn("run_count", "integer", (col) => col.notNull().defaultTo(1))
    .addColumn("created_at", "timestamptz", (col) =>
      col.notNull().defaultTo(sql`now()`),
    )
    .execute();
  await db.schema
    .createIndex("idx_task_quota_claims_org_period")
    .on("task_quota_claims")
    .columns(["organization_id", "period_key"])
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable("task_quota_claims").ifExists().execute();
}
