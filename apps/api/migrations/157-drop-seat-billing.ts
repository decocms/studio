import { type Kysely, sql } from "kysely";

/**
 * Per-seat billing is gone — the model pivoted to a flat per-org subscription
 * (one price, quantity 1) gating executions of the reports-pushed tasks.
 * Drop the seat machinery migrations 139–144 built up:
 *  - organization_paid_seat + seat_change_log (whole tables);
 *  - organization_billing.billing_mode (self_serve/invoiced was seat-specific),
 *    legacy (the old-org paywall exemption — the new gate only touches the
 *    reports-task flow, which no org uses by inheritance, so nobody needs
 *    exempting), included_report_url / armed_report_url (the weekly-report
 *    benefit) and benefits_reference_id (+ its partial index) — the durable
 *    benefit-sync intent marker; the sync workflow is deleted with this
 *    migration.
 * KEPT on organization_billing: status / stripe ids / current_period_end /
 * last_stripe_event_at — the org-subscription core the webhook still writes.
 *
 * Nothing was ever enforced in production (STUDIO_BILLING_ENFORCED never
 * set), so the dropped data is staging noise at most.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable("seat_change_log").ifExists().execute();
  await db.schema.dropTable("organization_paid_seat").ifExists().execute();
  await sql`drop index if exists idx_org_billing_benefits_pending`.execute(db);
  await db.schema
    .alterTable("organization_billing")
    .dropColumn("billing_mode")
    .execute();
  // The migration-139 backfill (pre-billing orgs = true) is not restorable on
  // down; irrelevant — the flag gated a paywall that no longer exists.
  await db.schema
    .alterTable("organization_billing")
    .dropColumn("legacy")
    .execute();
  await db.schema
    .alterTable("organization_billing")
    .dropColumn("included_report_url")
    .execute();
  await db.schema
    .alterTable("organization_billing")
    .dropColumn("armed_report_url")
    .execute();
  await db.schema
    .alterTable("organization_billing")
    .dropColumn("benefits_reference_id")
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .alterTable("organization_billing")
    .addColumn("legacy", "boolean", (col) => col.notNull().defaultTo(false))
    .execute();
  await db.schema
    .alterTable("organization_billing")
    .addColumn("billing_mode", "text", (col) =>
      col.notNull().defaultTo("self_serve"),
    )
    .execute();
  await db.schema
    .alterTable("organization_billing")
    .addColumn("included_report_url", "text")
    .execute();
  await db.schema
    .alterTable("organization_billing")
    .addColumn("armed_report_url", "text")
    .execute();
  await db.schema
    .alterTable("organization_billing")
    .addColumn("benefits_reference_id", "text")
    .execute();
  await sql`
    create index idx_org_billing_benefits_pending
      on organization_billing (updated_at)
      where benefits_reference_id is not null
  `.execute(db);
  await db.schema
    .createTable("organization_paid_seat")
    .addColumn("organization_id", "text", (col) =>
      col.notNull().references("organization.id").onDelete("cascade"),
    )
    .addColumn("user_id", "text", (col) => col.notNull())
    .addColumn("created_at", "timestamptz", (col) =>
      col.notNull().defaultTo(sql`now()`),
    )
    .addPrimaryKeyConstraint("organization_paid_seat_pk", [
      "organization_id",
      "user_id",
    ])
    .execute();
  await db.schema
    .createTable("seat_change_log")
    .addColumn("id", "uuid", (col) =>
      col.primaryKey().defaultTo(sql`gen_random_uuid()`),
    )
    .addColumn("organization_id", "text", (col) =>
      col.notNull().references("organization.id").onDelete("cascade"),
    )
    .addColumn("user_id", "text", (col) => col.notNull())
    .addColumn("seat", "text", (col) => col.notNull())
    .addColumn("changed_by", "text", (col) => col.notNull())
    .addColumn("created_at", "timestamptz", (col) =>
      col.notNull().defaultTo(sql`now()`),
    )
    .execute();
}
