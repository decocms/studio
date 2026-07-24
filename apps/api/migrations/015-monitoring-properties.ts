/**
 * Add Properties Column to Monitoring Logs
 *
 * Adds a `properties` column to store custom key-value metadata for log correlation.
 * Properties are stored as JSON text with string values.
 */

import { Kysely } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  // Add properties column (nullable JSON text)
  await db.schema
    .alterTable("monitoring_logs")
    .addColumn("properties", "text")
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .alterTable("monitoring_logs")
    .dropColumn("properties")
    .execute();
}
