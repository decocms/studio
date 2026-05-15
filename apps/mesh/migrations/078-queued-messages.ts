/**
 * Queued messages — pending agent runs awaiting dispatch on the per-thread
 * gate queue.
 *
 * Row lifecycle:
 * - Inserted with status='queued' at POST /messages, before the workflow is
 *   enqueued. Holds the message text so the inbox UI can render pending
 *   bubbles above the input.
 * - On DELETE /messages/:id, the row is atomically transitioned to
 *   'cancelled' (CAS). The workflow consumer checks this on dequeue and
 *   skips dispatch if the row is gone or cancelled.
 * - The workflow consumer deletes the row at the start of dispatch (the
 *   message is now "running" — it appears in the chat as the streaming
 *   response, not in the inbox).
 *
 * No 'running' / 'consumed' states persisted — the workflow journal is the
 * source of truth for in-flight work, this table only tracks the inbox.
 */

import type { Kysely } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable("queued_messages")
    .addColumn("id", "text", (col) => col.primaryKey())
    .addColumn("thread_id", "text", (col) => col.notNull())
    .addColumn("organization_id", "text", (col) => col.notNull())
    .addColumn("user_id", "text", (col) => col.notNull())
    .addColumn("content", "text", (col) => col.notNull())
    .addColumn("status", "text", (col) => col.notNull().defaultTo("queued"))
    .addColumn("workflow_id", "text", (col) => col.notNull())
    .addColumn("created_at", "timestamptz", (col) =>
      col.notNull().defaultTo("now()"),
    )
    .execute();

  await db.schema
    .createIndex("queued_messages_thread_id_created_at_idx")
    .on("queued_messages")
    .columns(["thread_id", "created_at"])
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable("queued_messages").execute();
}
