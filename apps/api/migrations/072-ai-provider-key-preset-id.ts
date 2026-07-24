import { type Kysely } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .alterTable("ai_provider_keys")
    .addColumn("preset_id", "text")
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .alterTable("ai_provider_keys")
    .dropColumn("preset_id")
    .execute();
}
