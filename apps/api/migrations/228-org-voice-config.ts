import { sql, type Kysely } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .alterTable("organization_settings")
    .addColumn("voice_provider", "text")
    .addColumn("voice_model", "text")
    .execute();
  await db.schema
    .alterTable("organization_settings")
    .addCheckConstraint(
      "organization_settings_voice_provider_check",
      sql`voice_provider in ('elevenlabs', 'openai')`,
    )
    .execute();
  await db.schema
    .alterTable("organization_settings")
    .addCheckConstraint(
      "organization_settings_voice_model_check",
      sql`voice_model is null or (voice_provider is not null and length(btrim(voice_model)) between 1 and 128)`,
    )
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .alterTable("organization_settings")
    .dropColumn("voice_model")
    .dropColumn("voice_provider")
    .execute();
}
