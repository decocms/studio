import type { Kysely } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .alterTable("threads")
    .addColumn("inflight_async_jobs", "jsonb")
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .alterTable("threads")
    .dropColumn("inflight_async_jobs")
    .execute();
}
