import { type Kysely, sql } from "kysely";

/**
 * Per-seat billing is gone (pivot to a flat per-org subscription gating
 * reports-task executions). Drops what migrations 139–144 built: the
 * organization_paid_seat + seat_change_log tables and the seat-specific
 * organization_billing columns (billing_mode, legacy, included_report_url,
 * armed_report_url, benefits_reference_id + partial index). Keeps the
 * subscription core: status / stripe ids / period / event watermark.
 * Nothing was ever enforced in production (STUDIO_BILLING_ENFORCED unset).
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable("seat_change_log").ifExists().execute();
  await db.schema.dropTable("organization_paid_seat").ifExists().execute();
  await sql`drop index if exists idx_org_billing_benefits_pending`.execute(db);
  await db.schema
    .alterTable("organization_billing")
    .dropColumn("billing_mode")
    .execute();
  // 139's legacy backfill is not restorable on down (gated nothing by now).
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
