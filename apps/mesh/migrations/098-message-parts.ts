/**
 * Message Parts Migration (expand phase)
 *
 * Moves `thread_messages.parts` (a JSON array blob, frequently 50 MB+ on busy
 * threads because tool-result parts inline large payloads) into a normalized
 * `message_parts` table — one row per part.
 *
 * This is the first, additive step of an expand/contract migration:
 *   098 (this)  create message_parts                 — additive, no lock on thread_messages
 *   + deploy    dual-write saveMessages → both columns
 *   + backfill  `deco backfill-message-parts`         — copy existing parts, batched/resumable
 *   + deploy    cut reads over to message_parts
 *   + deploy    stop writing thread_messages.parts
 *   later       ALTER TABLE thread_messages DROP COLUMN parts  (then pg_repack to reclaim disk)
 *
 * `content` holds each part as a JSON-text fragment (NOT jsonb): real `parts`
 * blobs contain `\0` (e.g. binary tool outputs like ZIP headers), which
 * Postgres `jsonb`/`json` reject (22P05) but `text` stores fine — same as the
 * `thread_messages.parts` column does today. `type` is denormalized from
 * `part.type` for filtering. Reconstruct a message's array by concatenating the
 * fragments (the app then JSON.parses it, exactly like the old `parts` blob):
 *   SELECT coalesce('[' || string_agg(content, ',' ORDER BY idx) || ']', '[]')
 *   FROM message_parts WHERE message_id = $1
 *
 * `created_at`/`updated_at` are per-part (text, like `thread_messages`): a part
 * mutates in place across streaming saves (a tool-call goes input-streaming →
 * input-available → output-available at the same idx), so the dual-write
 * preserves `created_at` on conflict and bumps `updated_at` only when `content`
 * actually changes. Backfilled rows inherit the message's `created_at`, since
 * no true per-part time exists for them.
 */

import { type Kysely, sql } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable("message_parts")
    // CASCADE DELETE: parts vanish with their message (which itself cascades
    // from threads), so thread deletion still fully cleans up.
    .addColumn("message_id", "text", (col) =>
      col.notNull().references("thread_messages.id").onDelete("cascade"),
    )
    .addColumn("idx", "integer", (col) => col.notNull())
    .addColumn("type", "text", (col) => col.notNull())
    // text, not jsonb: parts can contain binary tool outputs, which
    // jsonb rejects. Stores the JSON-text fragment verbatim, like `parts`.
    .addColumn("content", "text", (col) => col.notNull())
    .addColumn("created_at", "text", (col) =>
      col.notNull().defaultTo(sql`CURRENT_TIMESTAMP`),
    )
    .addColumn("updated_at", "text", (col) =>
      col.notNull().defaultTo(sql`CURRENT_TIMESTAMP`),
    )
    .addPrimaryKeyConstraint("message_parts_pkey", ["message_id", "idx"])
    .execute();

  // The PK (message_id, idx) already serves the canonical read
  // (WHERE message_id = $1 ORDER BY idx), so no extra index is needed.
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable("message_parts").execute();
}
