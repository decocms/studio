import type { Kysely } from "kysely";

/**
 * The configuration_state keys a connection's MCP marks secret (`Secret()`
 * in its state schema). Tool responses redact their values. Null until the
 * MCP's configuration is next fetched, which keeps older rows unredacted.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .alterTable("connections")
    .addColumn("configuration_secret_fields", "text")
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .alterTable("connections")
    .dropColumn("configuration_secret_fields")
    .execute();
}
