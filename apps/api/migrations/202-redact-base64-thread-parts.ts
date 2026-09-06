import { type Kysely, sql } from "kysely";
import { serializePayload } from "../src/storage/thread-message-parts";

/**
 * Backfill for the redaction added to `serializePayload`: strip the base64
 * image bytes already sitting in `thread_message_parts`. At the time of writing
 * that is 700 rows holding 74 MB, and every one of them is folded back into the
 * prompt of each later turn on its thread.
 *
 * The candidate filter is two-stage on purpose. `pg_column_size` reads the
 * TOAST pointer without detoasting, so it cuts 1M rows to ~19k for the cost of
 * a heap scan; only those get detoasted for the `LIKE`. Payloads are then
 * fetched by id in small batches — the matching rows total tens of MB and must
 * not land in one result set.
 *
 * Rewriting is the same `serializePayload` the writer uses, so a row that holds
 * nothing to redact serializes byte-identically and is skipped. Re-running
 * changes nothing, and there is no `down`: the bytes are gone.
 */
const BATCH = 20;

export async function up(db: Kysely<unknown>): Promise<void> {
  const candidates = await sql<{ id: string }>`
    SELECT id FROM thread_message_parts
    WHERE pg_column_size(payload) > 8192
      AND (payload::text LIKE '%"type": "image"%' OR payload::text LIKE '%;base64,%')
  `.execute(db);

  for (let i = 0; i < candidates.rows.length; i += BATCH) {
    const ids = candidates.rows.slice(i, i + BATCH).map((r) => r.id);
    const batch = await sql<{ id: string; payload: unknown }>`
      SELECT id, payload FROM thread_message_parts WHERE id = ANY(${ids})
    `.execute(db);

    for (const row of batch.rows) {
      const redacted = serializePayload(row.payload);
      if (redacted === JSON.stringify(row.payload)) continue;
      await sql`
        UPDATE thread_message_parts
        SET payload = ${redacted}::jsonb
        WHERE id = ${row.id}
      `.execute(db);
    }
  }
}

export async function down(): Promise<void> {
  // Irreversible — the image bytes are not recoverable.
}
