import { type Kysely, sql } from "kysely";

/** An org's own thresholds for an alert rule; a rule without a row uses the source's defaults. */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable("alert_rule_settings")
    .addColumn("organization_id", "text", (col) =>
      col.notNull().references("organization.id").onDelete("cascade"),
    )
    .addColumn("source", "text", (col) => col.notNull())
    .addColumn("rule", "text", (col) => col.notNull())
    .addColumn("threshold", "double precision", (col) => col.notNull())
    .addColumn("min_volume", "double precision", (col) => col.notNull())
    .addColumn("updated_at", "timestamptz", (col) =>
      col.notNull().defaultTo(sql`now()`),
    )
    .addColumn("updated_by", "text")
    .addPrimaryKeyConstraint("alert_rule_settings_pkey", [
      "organization_id",
      "source",
      "rule",
    ])
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable("alert_rule_settings").ifExists().execute();
}
