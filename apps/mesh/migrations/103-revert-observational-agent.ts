/**
 * Revert Observational Agent (reverts migration 102)
 *
 * #3695 was reverted. Migration 102 stays in the chain (it had already been
 * applied to some environments, e.g. staging, so removing it would trip
 * Kysely's corrupted-migrations check). This forward migration drops the schema
 * 102 created instead:
 * - thread_observations table
 * - threads.is_observation column
 * - organization_settings.observational_config column
 *
 * Net effect across every environment is the pre-102 schema, whether or not 102
 * had already run there.
 */

import { Kysely } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable("thread_observations").ifExists().execute();

  await db.schema.alterTable("threads").dropColumn("is_observation").execute();

  await db.schema
    .alterTable("organization_settings")
    .dropColumn("observational_config")
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
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
    .addColumn("thread_id", "text", (col) =>
      col.notNull().references("threads.id").onDelete("cascade"),
    )
    .addColumn("observer_id", "text", (col) => col.notNull())
    .addColumn("last_observed_at", "text", (col) => col.notNull())
    .addPrimaryKeyConstraint("thread_observations_pkey", [
      "thread_id",
      "observer_id",
    ])
    .execute();
}
