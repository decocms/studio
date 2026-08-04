import { type Kysely, sql } from "kysely";

/**
 * Per-client subsidy keys: the gateway API key Studio provisions under the
 * synthetic gateway org `subsidy:<organization_id>` to pay for
 * subscription-included task runs (billing/subsidized-runs.ts). One row per
 * org, vault-encrypted — the gateway meters usage per key, so per-client
 * COGS attribution falls out of its existing ledger.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable("subsidized_gateway_keys")
    .addColumn("organization_id", "text", (col) =>
      col.primaryKey().references("organization.id").onDelete("cascade"),
    )
    .addColumn("encrypted_key", "text", (col) => col.notNull())
    .addColumn("created_at", "timestamptz", (col) =>
      col.notNull().defaultTo(sql`now()`),
    )
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable("subsidized_gateway_keys").ifExists().execute();
}
