import { type Kysely } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .alterTable("ai_provider_keys")
    .addColumn("key_hash", "text")
    .execute();

  // Unique index on (org, provider, key_hash). NULLs are not considered equal
  // in PostgreSQL unique indexes, so existing rows (key_hash = NULL) won't
  // conflict with each other — only new rows with the same hash will.
  await db.schema
    .createIndex("idx_ai_provider_keys_unique_hash")
    .unique()
    .on("ai_provider_keys")
    .columns(["organization_id", "provider_id", "key_hash"])
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropIndex("idx_ai_provider_keys_unique_hash").execute();

  await db.schema
    .alterTable("ai_provider_keys")
    .dropColumn("key_hash")
    .execute();
}
