/**
 * Remove Gateway is_default Migration
 *
 * Removes the is_default column from the gateways table and its associated index.
 * The is_default column was used to mark the Organization Agent, but this functionality
 * is being removed.
 */

import { Kysely, sql } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  // Drop the partial unique index that enforces one default per org
  await sql`DROP INDEX IF EXISTS idx_gateways_default_per_org`.execute(db);

  // Remove the is_default column from gateways table
  // SQLite 3.25+ and PostgreSQL support DROP COLUMN directly
  await db.schema.alterTable("gateways").dropColumn("is_default").execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  // Add back the is_default column
  await db.schema
    .alterTable("gateways")
    .addColumn("is_default", "integer", (col) => col.notNull().defaultTo(0))
    .execute();

  // Recreate the partial unique index
  await sql`CREATE UNIQUE INDEX idx_gateways_default_per_org ON gateways (organization_id) WHERE is_default = 1`.execute(
    db,
  );
}
