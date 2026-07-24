/**
 * Thread Status Migration
 *
 * Adds a `status` column to the threads table for tracking execution state:
 * - in_progress: Stream is active
 * - requires_action: Waiting for user input (user_ask)
 * - failed: Error or abort
 * - completed: Finished successfully
 *
 * Default is "completed" so existing threads are treated as finished.
 */

import { Kysely } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .alterTable("threads")
    .addColumn("status", "text", (col) => col.notNull().defaultTo("completed"))
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.alterTable("threads").dropColumn("status").execute();
}
