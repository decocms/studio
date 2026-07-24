/**
 * Drop the `tools` column from the `connections` table.
 *
 * Tool lists are now cached exclusively in NATS KV (bucket DECOCMS_MCP_LISTS)
 * and hydrated at read time by the COLLECTION_CONNECTIONS_LIST tool.
 * The column has been set to NULL on every create/update since the NATS KV
 * migration, so no data is lost.
 */

import type { Kysely } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema.alterTable("connections").dropColumn("tools").execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .alterTable("connections")
    .addColumn("tools", "text")
    .execute();
}
