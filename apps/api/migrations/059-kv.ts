/**
 * Migration 059: KV Store
 *
 * Generic org-scoped key-value store. Used by external MCPs
 * (via StudioKV in @decocms/runtime) to persist small amounts of data.
 */

import type { Kysely } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable("kv")
    .addColumn("organization_id", "text", (col) => col.notNull())
    .addColumn("key", "text", (col) => col.notNull())
    .addColumn("value", "jsonb", (col) => col.notNull())
    .addColumn("updated_at", "timestamptz", (col) =>
      col.notNull().defaultTo("now()"),
    )
    .addPrimaryKeyConstraint("kv_pkey", ["organization_id", "key"])
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable("kv").execute();
}
