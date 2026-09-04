import { type Kysely, sql } from "kysely";

/**
 * Immutable ownership snapshots for Commerce Discovery runs.
 *
 * The singleton report connection is mutable: a later setup may point it at a
 * different site or project. Imports arrive asynchronously, so resolving their
 * owner from that connection can attach an older run's findings to the newer
 * project. The originating `/upgrade` or `/run` response gives us the stable
 * run id; this table pins that run to the site and project active at creation.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable("commerce_discovery_report_runs")
    .addColumn("organization_id", "text", (column) =>
      column.notNull().references("organization.id").onDelete("cascade"),
    )
    .addColumn("run_id", "text", (column) => column.notNull())
    .addColumn("site_url", "text", (column) => column.notNull())
    .addColumn("virtual_mcp_id", "text", (column) => column.notNull())
    .addColumn("created_at", "timestamptz", (column) =>
      column.notNull().defaultTo(sql`now()`),
    )
    .addPrimaryKeyConstraint("commerce_discovery_report_runs_pkey", [
      "organization_id",
      "run_id",
    ])
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable("commerce_discovery_report_runs").execute();
}
