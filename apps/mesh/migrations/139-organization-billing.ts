import { type Kysely, sql } from "kysely";

/**
 * Per-seat billing foundation (dormant until STUDIO_BILLING_ENFORCED=true):
 *
 * 1. `organization_billing` — one row per org, the billing identity. Written
 *    only by the platform (migration backfill, the org-creation hook and —
 *    later — Stripe webhooks); deliberately NOT in org `metadata`, which org
 *    admins can write via ORGANIZATION_UPDATE (billing there would let any
 *    admin flag their own org legacy). Every org existing at migration time
 *    is backfilled `legacy = true` (exempt forever — the cutoff is this
 *    deploy); orgs created afterwards get `legacy = false` from the
 *    org-creation hook.
 *
 * 2. `organization_paid_seat` — presence = this member has a paid seat.
 *    Absence = free seat (readonly + no AI when enforcement is on), so the
 *    empty table is the correct default for every new org.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable("organization_billing")
    .addColumn("organization_id", "text", (col) =>
      col.primaryKey().references("organization.id").onDelete("cascade"),
    )
    .addColumn("legacy", "boolean", (col) => col.notNull().defaultTo(false))
    .addColumn("billing_mode", "text", (col) =>
      col.notNull().defaultTo("self_serve"),
    )
    .addColumn("status", "text", (col) => col.notNull().defaultTo("none"))
    .addColumn("stripe_customer_id", "text")
    .addColumn("stripe_subscription_id", "text")
    .addColumn("current_period_end", "timestamptz")
    .addColumn("included_report_url", "text")
    .addColumn("created_at", "timestamptz", (col) =>
      col.notNull().defaultTo(sql`now()`),
    )
    .addColumn("updated_at", "timestamptz", (col) =>
      col.notNull().defaultTo(sql`now()`),
    )
    .execute();

  await db.schema
    .createTable("organization_paid_seat")
    .addColumn("organization_id", "text", (col) =>
      col.notNull().references("organization.id").onDelete("cascade"),
    )
    .addColumn("user_id", "text", (col) => col.notNull())
    .addColumn("created_at", "timestamptz", (col) =>
      col.notNull().defaultTo(sql`now()`),
    )
    .addPrimaryKeyConstraint("organization_paid_seat_pkey", [
      "organization_id",
      "user_id",
    ])
    .execute();

  await sql`
    insert into organization_billing (organization_id, legacy)
    select id, true from organization
    on conflict (organization_id) do nothing
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable("organization_paid_seat").execute();
  await db.schema.dropTable("organization_billing").execute();
}
