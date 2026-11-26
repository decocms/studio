import type { Kysely } from "kysely";

/**
 * Which BigQuery connection and GA4 dataset the built-in Plan engine reads,
 * one per organization. Its own table, not columns on
 * `plan_ux_site_profiles`: setup comes before the store's domain is known,
 * and a profile row needs a domain. The binding goes with its organization
 * and with the BigQuery connection it names.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable("plan_ux_bigquery_bindings")
    .ifNotExists()
    .addColumn("organization_id", "text", (col) =>
      col.primaryKey().references("organization.id").onDelete("cascade"),
    )
    .addColumn("connection_id", "text", (col) =>
      col.notNull().references("connections.id").onDelete("cascade"),
    )
    .addColumn("project_id", "text", (col) => col.notNull())
    .addColumn("dataset_id", "text", (col) => col.notNull())
    .addColumn("updated_at", "timestamptz", (col) => col.notNull())
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable("plan_ux_bigquery_bindings").ifExists().execute();
}
