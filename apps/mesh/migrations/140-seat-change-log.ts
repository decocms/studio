import { type Kysely, sql } from "kysely";

/**
 * Append-only log of seat transitions (paid <-> free), written in the same
 * transaction as the organization_paid_seat change. For `invoiced`
 * (contract) orgs this IS the billing source: end-of-cycle invoicing reads
 * who held a paid seat when, so rows are only appended for ACTUAL
 * transitions (a no-op "set paid on already-paid" writes nothing).
 */
export async function up(db: Kysely<unknown>): Promise<void> {
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

  await db.schema
    .createIndex("idx_seat_change_log_org_created")
    .on("seat_change_log")
    .columns(["organization_id", "created_at"])
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable("seat_change_log").execute();
}
