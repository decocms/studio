/**
 * Migration 052: Trigger Callback Tokens
 *
 * Stores hashed callback tokens that external MCPs use to call back
 * to Studio when a trigger fires (e.g., GitHub webhook → Studio automation).
 * One token per connection+organization pair.
 */

import type { Kysely } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable("trigger_callback_tokens")
    .addColumn("id", "text", (col) => col.primaryKey())
    .addColumn("organization_id", "text", (col) => col.notNull())
    .addColumn("connection_id", "text", (col) =>
      col.notNull().references("connections.id").onDelete("cascade"),
    )
    .addColumn("token_hash", "text", (col) => col.notNull().unique())
    .addColumn("created_at", "timestamptz", (col) =>
      col.notNull().defaultTo("now()"),
    )
    .execute();

  await db.schema
    .createIndex("idx_trigger_callback_tokens_connection_org")
    .on("trigger_callback_tokens")
    .columns(["connection_id", "organization_id"])
    .unique()
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable("trigger_callback_tokens").execute();
}
