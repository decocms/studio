/**
 * Observational Agent — multiple observers per org.
 *
 * Replaces the single threads.last_observed_at column with a normalized
 * per-(thread, observer) watermark table, so N observers each track their own
 * progress on the same thread independently. The observational_config JSON also
 * goes from a single observer to { observers: [...] } (app-level, no schema
 * change to the text column).
 */

import { Kysely } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable("thread_observations")
    // CASCADE DELETE: watermarks vanish with their thread.
    .addColumn("thread_id", "text", (col) =>
      col.notNull().references("threads.id").onDelete("cascade"),
    )
    // The observer config id (organization_settings.observational_config.observers[].id).
    .addColumn("observer_id", "text", (col) => col.notNull())
    // ISO text, mirrors threads.updated_at; high-water mark of this observer's
    // last pass over this thread. Compared lexically against updated_at.
    .addColumn("last_observed_at", "text", (col) => col.notNull())
    .addPrimaryKeyConstraint("thread_observations_pkey", [
      "thread_id",
      "observer_id",
    ])
    .execute();

  await db.schema
    .alterTable("threads")
    .dropColumn("last_observed_at")
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .alterTable("threads")
    .addColumn("last_observed_at", "text")
    .execute();

  await db.schema.dropTable("thread_observations").execute();
}
