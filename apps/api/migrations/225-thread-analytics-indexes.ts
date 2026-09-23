import { sql, type Kysely } from "kysely";

/**
 * The admin thread analytics read across every org with no thread_id to
 * narrow by: spend scans `finish` parts by `persisted_at`, the live view sorts
 * all threads by `updated_at`, and its counters look up active statuses. The
 * existing indexes are all org- or thread-prefixed.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`CREATE INDEX idx_tmp_finish_persisted_at ON thread_message_parts (persisted_at DESC) WHERE kind = 'finish'`.execute(
    db,
  );
  await sql`CREATE INDEX idx_threads_updated_at ON threads (updated_at DESC)`.execute(
    db,
  );
  await sql`CREATE INDEX idx_threads_active_status ON threads (status) WHERE status IN ('in_progress', 'requires_action')`.execute(
    db,
  );
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropIndex("idx_threads_active_status").execute();
  await db.schema.dropIndex("idx_threads_updated_at").execute();
  await db.schema.dropIndex("idx_tmp_finish_persisted_at").execute();
}
