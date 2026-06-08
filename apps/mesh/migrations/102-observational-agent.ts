/**
 * Observational Agent Migration
 *
 * - organization_settings.observational_config: JSON config for the per-org
 *   observational agents feature ({ observers: [{ id, agentId, scopeMode,
 *   scopeAgentIds, model, configuredAt }] }).
 * - threads.is_observation: true for observer-run output threads, so the sweep
 *   excludes them structurally (independent of the current observer agent id),
 *   the way automation threads are excluded via trigger_id.
 * - thread_observations: per-(thread, observer) watermark, so N observers each
 *   track their own progress over the same thread independently. last_observed_at
 *   is ISO text compared lexically against threads.updated_at.
 */

import { Kysely } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .alterTable("organization_settings")
    .addColumn("observational_config", "text")
    .execute();

  await db.schema
    .alterTable("threads")
    .addColumn("is_observation", "boolean", (col) =>
      col.notNull().defaultTo(false),
    )
    .execute();

  await db.schema
    .createTable("thread_observations")
    // CASCADE DELETE: watermarks vanish with their thread.
    .addColumn("thread_id", "text", (col) =>
      col.notNull().references("threads.id").onDelete("cascade"),
    )
    // The observer config id (observational_config.observers[].id).
    .addColumn("observer_id", "text", (col) => col.notNull())
    // ISO text, mirrors threads.updated_at; high-water mark of this observer's
    // last pass over this thread. Compared lexically against updated_at.
    .addColumn("last_observed_at", "text", (col) => col.notNull())
    .addPrimaryKeyConstraint("thread_observations_pkey", [
      "thread_id",
      "observer_id",
    ])
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable("thread_observations").execute();

  await db.schema.alterTable("threads").dropColumn("is_observation").execute();

  await db.schema
    .alterTable("organization_settings")
    .dropColumn("observational_config")
    .execute();
}
