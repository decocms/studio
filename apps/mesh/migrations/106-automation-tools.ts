import { type Kysely } from "kysely";

/**
 * Per-automation tool allowlist. A JSON-encoded `string[]` of model-facing
 * tool names the run is restricted to. `null` (the default) means "all of the
 * bound agent's tools" — the pre-existing behavior, so existing automations are
 * untouched.
 *
 * The specific-model override (pinning a concrete model instead of an org tier
 * preset) needs no schema change — it rides in the existing `models` JSON
 * column as optional `{ modelId, credentialId }` alongside `{ tier }`.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .alterTable("automations")
    .addColumn("tools", "text") // JSON-encoded string[] | null = all tools
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.alterTable("automations").dropColumn("tools").execute();
}
