/**
 * Migration 078: Add run_locally column to threads
 *
 * Persists the "Run locally" choice per thread (Phase 10 of the remote
 * harness dispatch project). When true, every message on this thread is
 * dispatched to the thread owner's link daemon instead of the
 * in-cluster sandbox.
 *
 * The column is set on first-message creation from the POST body and is
 * not modified afterwards, so DBOS replays and subsequent messages all
 * agree on where the run executes. Defaults to false so every existing
 * thread continues to behave as a normal cluster-side thread.
 */

import type { Kysely } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .alterTable("threads")
    .addColumn("run_locally", "boolean", (col) =>
      col.notNull().defaultTo(false),
    )
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.alterTable("threads").dropColumn("run_locally").execute();
}
