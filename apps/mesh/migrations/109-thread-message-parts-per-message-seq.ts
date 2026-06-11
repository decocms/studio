import { sql, type Kysely } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  // Part ids are now `${runId}:${messageId}:${seq}` (seq is per-MESSAGE, not
  // per-run), so (run_id, seq) is no longer unique across messages in a run.
  // The `id` primary key still guarantees row uniqueness.
  await sql`DROP INDEX IF EXISTS idx_tmp_run_seq`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`CREATE UNIQUE INDEX IF NOT EXISTS idx_tmp_run_seq ON thread_message_parts (run_id, seq)`.execute(
    db,
  );
}
