import { type Kysely, sql } from "kysely";

/** Who gets the org's sales report by email, and at which local hours; no row = not subscribed. */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable("sales_report_subscriptions")
    .addColumn("organization_id", "text", (col) =>
      col.notNull().references("organization.id").onDelete("cascade"),
    )
    .addColumn("user_id", "text", (col) =>
      col.notNull().references("user.id").onDelete("cascade"),
    )
    .addColumn("hours", sql`smallint[]`, (col) => col.notNull())
    .addColumn("updated_at", "timestamptz", (col) =>
      col.notNull().defaultTo(sql`now()`),
    )
    .addPrimaryKeyConstraint("sales_report_subscriptions_pkey", [
      "organization_id",
      "user_id",
    ])
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable("sales_report_subscriptions").ifExists().execute();
}
