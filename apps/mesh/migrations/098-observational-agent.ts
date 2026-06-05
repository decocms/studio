/**
 * Observational Agent Migration
 *
 * - organization_settings.observational_config: JSON config for the per-org
 *   observational agent feature ({ agentId, skipAgentIds, inactiveMinutes }).
 * - threads.last_observed_at: high-water mark (ISO text, mirrors updated_at's
 *   storage) of the last time the observational sweep processed this thread.
 *   Stored as `text` so `last_observed_at < updated_at` is a lexical ISO-8601
 *   comparison consistent with how updated_at is written/compared elsewhere.
 * - threads.is_observation: true for observer-run output threads, so the sweep
 *   excludes them structurally (independent of the current observer agent id),
 *   the way automation threads are excluded via trigger_id.
 */

import { Kysely } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .alterTable("organization_settings")
    .addColumn("observational_config", "text")
    .execute();

  await db.schema
    .alterTable("threads")
    .addColumn("last_observed_at", "text")
    .execute();

  await db.schema
    .alterTable("threads")
    .addColumn("is_observation", "boolean", (col) =>
      col.notNull().defaultTo(false),
    )
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.alterTable("threads").dropColumn("is_observation").execute();

  await db.schema
    .alterTable("threads")
    .dropColumn("last_observed_at")
    .execute();

  await db.schema
    .alterTable("organization_settings")
    .dropColumn("observational_config")
    .execute();
}
