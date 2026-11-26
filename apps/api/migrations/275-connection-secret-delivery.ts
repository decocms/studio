import type { Kysely } from "kysely";

/**
 * "fetch" when the connection's MCP runtime reads its secret configuration
 * back from Studio, so the request token can leave those fields out.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .alterTable("connections")
    .addColumn("configuration_secret_delivery", "text")
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .alterTable("connections")
    .dropColumn("configuration_secret_delivery")
    .execute();
}
