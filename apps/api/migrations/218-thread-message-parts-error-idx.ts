import { sql, type Kysely } from "kysely";

/**
 * The task board analytics "Errors" panels (live error feed, error
 * signatures) filter `thread_message_parts` by `kind = 'error'` and a
 * `persisted_at` range across every thread in the org, with no thread_id to
 * narrow by first — unlike the `finish`/`latest-assistant-text` partial
 * indexes (migrations 098, 153), which are scoped per-thread. Without an
 * index on `kind = 'error'`, that range scan walks the whole table.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`CREATE INDEX idx_tmp_error_persisted_at ON thread_message_parts (persisted_at DESC) WHERE kind = 'error'`.execute(
    db,
  );
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropIndex("idx_tmp_error_persisted_at").execute();
}
