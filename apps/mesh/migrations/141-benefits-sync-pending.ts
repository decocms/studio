import { type Kysely } from "kysely";

/**
 * Durable benefit sync: `benefits_reference_id` is the pending-grant marker,
 * written INSIDE the same transaction as the seat change (setSeats /
 * releaseSeat) — so a crash anywhere after commit can never lose the intent.
 * Non-null = "the gateway allowance grant for this change-set hasn't been
 * confirmed yet"; the value is the grant's idempotency key at the gateway.
 * Cleared (CAS) by the sync workflow on success; a scheduled sweep re-enqueues
 * rows that stay pending (pod died before enqueue, gateway down past the
 * step-retry budget).
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .alterTable("organization_billing")
    .addColumn("benefits_reference_id", "text")
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .alterTable("organization_billing")
    .dropColumn("benefits_reference_id")
    .execute();
}
