/**
 * Re-add next_run_at to automation_triggers
 *
 * Migration 040 removed next_run_at in favor of last_run_at for crash safety.
 * We now add it back as a **denormalized cache column** for indexed queries.
 * last_run_at remains the source of truth; next_run_at is always recomputable
 * from cron_expression + last_run_at and is used purely for efficient
 * "find due triggers" queries with a partial B-tree index.
 */

import { Kysely, sql } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .alterTable("automation_triggers")
    .addColumn("next_run_at", "text")
    .execute();

  // Partial index: only cron triggers need next_run_at lookups
  await sql`CREATE INDEX idx_automation_triggers_next_run ON automation_triggers (next_run_at) WHERE type = 'cron'`.execute(
    db,
  );
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP INDEX IF EXISTS idx_automation_triggers_next_run`.execute(db);

  await db.schema
    .alterTable("automation_triggers")
    .dropColumn("next_run_at")
    .execute();
}
