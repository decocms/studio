/**
 * Add updated_by column to connections table
 *
 * This migration adds the `updated_by` column to the connections table to track
 * which user last updated each connection. This column is nullable to support
 * existing connections that were created before this migration.
 */

import { type Kysely } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .alterTable("connections")
    .addColumn("updated_by", "text")
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.alterTable("connections").dropColumn("updated_by").execute();
}
