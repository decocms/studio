import { sql, type Kysely } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .alterTable("threads")
    .addColumn("run_owner_pod", "text")
    .addColumn("run_config", "jsonb")
    .addColumn("run_started_at", "timestamptz")
    .execute();

  await sql`CREATE INDEX idx_threads_run_owner ON threads (status, run_owner_pod) WHERE status = 'in_progress'`.execute(
    db,
  );
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropIndex("idx_threads_run_owner").ifExists().execute();
  await db.schema
    .alterTable("threads")
    .dropColumn("run_owner_pod")
    .dropColumn("run_config")
    .dropColumn("run_started_at")
    .execute();
}
