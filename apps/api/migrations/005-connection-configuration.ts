/**
 * Connection Configuration Migration
 *
 * Adds configuration state and scopes to connections table.
 * This allows MCPs to declare their configuration needs via MESH_CONFIGURATION tool.
 */

import { Kysely } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  // Add configuration fields to connections table
  await db.schema
    .alterTable("connections")
    .addColumn("configuration_state", "text") // Encrypted JSON state
    .execute();

  await db.schema
    .alterTable("connections")
    .addColumn("configuration_scopes", "text") // JSON array of scope strings
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  // Remove configuration fields
  await db.schema
    .alterTable("connections")
    .dropColumn("configuration_state")
    .execute();

  await db.schema
    .alterTable("connections")
    .dropColumn("configuration_scopes")
    .execute();
}
