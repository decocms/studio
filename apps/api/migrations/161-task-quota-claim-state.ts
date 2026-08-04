import { type Kysely, sql } from "kysely";

/**
 * Refundable task-quota claims (billing/task-quota.ts). A dispatch CHARGES
 * (state `held`, counted against the period); the charge is refunded — state
 * `released` — only when the run demonstrably produced nothing: no pull
 * request, the card never reached In Review, and no other run on the task is
 * still in flight. Those are durable facts on the board, so the refund
 * decision has exactly one writer and no event to miss.
 *
 * `released` rows stop counting toward the period but keep their `run_count`,
 * so a refund can never be looped into free dispatches: the per-task
 * execution cap still applies.
 *
 * Pre-existing rows default to `held` — they were charged at dispatch under
 * the previous semantics, and `held` IS the charged state, so the backfill is
 * a no-op in meaning.
 *
 * down() drops the column, which makes previously-refunded claims count
 * again — the conservative direction (billing, not refunding, on rollback).
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .alterTable("task_quota_claims")
    .addColumn("state", "text", (col) =>
      col.notNull().defaultTo("held").check(sql`state in ('held', 'released')`),
    )
    .execute();
  // Every count filters on state now, so the plain (org, period) index from
  // migration 160 is a redundant prefix — replace it with a partial index
  // over the rows that actually count.
  await db.schema.dropIndex("idx_task_quota_claims_org_period").execute();
  await sql`
    create index idx_task_quota_claims_org_period_live
      on task_quota_claims (organization_id, period_key)
      where state <> 'released'
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`drop index if exists idx_task_quota_claims_org_period_live`.execute(
    db,
  );
  await db.schema
    .createIndex("idx_task_quota_claims_org_period")
    .on("task_quota_claims")
    .columns(["organization_id", "period_key"])
    .execute();
  await db.schema.alterTable("task_quota_claims").dropColumn("state").execute();
}
