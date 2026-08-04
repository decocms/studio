import { type Kysely, sql } from "kysely";

/**
 * Persistence for the task-execution quota and the subsidized runs it sells
 * (see billing/task-quota.ts and billing/subsidized-runs.ts).
 *
 * `task_quota_claims` — one claim per reports-pushed task, written the FIRST
 * time it is dispatched. `period_key` buckets the count without a cron:
 * "trial" while nothing is being paid, "sub:pending" right after checkout,
 * else the subscription's current period end (which invoice.paid refreshes,
 * minting a fresh bucket each cycle). `run_count` bounds what one claim can
 * spend: every dispatch increments it and the claim stops authorizing runs
 * past STUDIO_MAX_RUNS_PER_TASK — without it, re-delegating a claimed task
 * in a loop would buy unlimited subscription-billed runs off one claim.
 *
 * `subsidized_gateway_keys` — the AI-gateway key Studio provisions per client
 * org (under the gateway's internal `subsidy:<organization_id>` org) to pay
 * for those runs. Vault-encrypted; the gateway meters usage per key, so
 * per-client COGS attribution falls out of its existing ledger.
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

  await db.schema
    .createTable("subsidized_gateway_keys")
    .addColumn("organization_id", "text", (col) =>
      col.primaryKey().references("organization.id").onDelete("cascade"),
    )
    .addColumn("encrypted_key", "text", (col) => col.notNull())
    .addColumn("created_at", "timestamptz", (col) =>
      col.notNull().defaultTo(sql`now()`),
    )
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable("subsidized_gateway_keys").ifExists().execute();
  await db.schema.dropTable("task_quota_claims").ifExists().execute();
}
