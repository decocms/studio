import { sql, type Kysely } from "kysely";

/**
 * The task board's `attachThreads` query does a per-linked-thread lateral
 * join fetching the latest assistant text part (`role = 'assistant' AND kind
 * = 'text'`) for the card preview — the same "latest row of a kind" shape as
 * migration 098's `idx_tmp_finish_anchor`, but with no matching partial index.
 * Without it, Postgres walks `idx_tmp_thread_created_id` backwards from the
 * newest `created_at`, skipping every non-matching part (tool calls, deltas,
 * reasoning) until it finds one — the more turns a thread has, the more rows
 * it discards per task board list. Every board list/get call runs this once
 * per linked thread.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`CREATE INDEX idx_tmp_latest_assistant_text ON thread_message_parts (thread_id, created_at DESC, id DESC) WHERE role = 'assistant' AND kind = 'text'`.execute(
    db,
  );
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropIndex("idx_tmp_latest_assistant_text").execute();
}
