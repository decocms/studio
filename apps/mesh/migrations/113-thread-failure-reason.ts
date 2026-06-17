import type { Kysely } from "kysely";

/**
 * Persist the failure reason and kind on the threads row so the projector
 * can record WHY a run was marked failed (e.g. harness error, projection
 * error, transport error) instead of silently discarding the error text.
 *
 * Both columns are nullable: pre-existing failed rows stay null; only runs
 * failed via `markRunFailed(reason, kind)` will have them populated.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .alterTable("threads")
    .addColumn("failure_reason", "text")
    .execute();
  await db.schema
    .alterTable("threads")
    .addColumn("failure_kind", "text")
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.alterTable("threads").dropColumn("failure_kind").execute();
  await db.schema.alterTable("threads").dropColumn("failure_reason").execute();
}
