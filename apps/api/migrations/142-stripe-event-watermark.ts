import { type Kysely, sql } from "kysely";

/**
 * Stripe webhook ordering + integrity:
 *
 * 1. `last_stripe_event_at` — high-water mark of the newest applied Stripe
 *    event's `created` time. Stripe does not guarantee delivery order and
 *    retries for days; events older than the mark are skipped so a late
 *    redelivery can never regress subscription state (e.g. a replayed
 *    invoice.paid resurrecting a canceled org).
 *
 * 2. Unique partial index on `stripe_subscription_id` — two orgs must never
 *    claim the same subscription; the webhook's reverse lookup assumes it.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .alterTable("organization_billing")
    .addColumn("last_stripe_event_at", "timestamptz")
    .execute();
  await sql`
    create unique index organization_billing_stripe_subscription_id_uq
    on organization_billing (stripe_subscription_id)
    where stripe_subscription_id is not null
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`drop index organization_billing_stripe_subscription_id_uq`.execute(
    db,
  );
  await db.schema
    .alterTable("organization_billing")
    .dropColumn("last_stripe_event_at")
    .execute();
}
