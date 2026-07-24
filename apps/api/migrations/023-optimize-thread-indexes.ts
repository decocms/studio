/**
 * Optimize Thread Indexes Migration
 *
 * Improves indexes for threads and thread_messages tables:
 * - Removes redundant single-column indexes (covered by composite indexes)
 * - Adds `hidden` to the org index to match the main list query filter
 * - Adds `updated_at` to created_by index for sorted user queries
 * - Adds `id` to messages index for stable ordering tiebreaker
 */

import type { Kysely } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  // Drop redundant indexes
  // idx_threads_org is covered by idx_threads_org_updated (and its replacement)
  await db.schema.dropIndex("idx_threads_org").execute();
  // idx_thread_messages_thread is covered by idx_thread_messages_thread_created
  await db.schema.dropIndex("idx_thread_messages_thread").execute();

  // Drop indexes we're replacing with better versions
  await db.schema.dropIndex("idx_threads_org_updated").execute();
  await db.schema.dropIndex("idx_threads_created_by").execute();
  await db.schema.dropIndex("idx_thread_messages_thread_created").execute();

  // Create improved indexes

  // Query threads by org + hidden status + recent (main list query)
  // Matches: WHERE organization_id = ? AND hidden = false ORDER BY updated_at DESC
  await db.schema
    .createIndex("idx_threads_org_hidden_updated")
    .on("threads")
    .columns(["organization_id", "hidden", "updated_at"])
    .execute();

  // Query by creator with ordering (listByUserId)
  // Matches: WHERE created_by = ? ORDER BY updated_at DESC
  await db.schema
    .createIndex("idx_threads_created_by_updated")
    .on("threads")
    .columns(["created_by", "updated_at"])
    .execute();

  // Query messages by thread ordered by creation time + id (stable ordering)
  // Matches: WHERE thread_id = ? ORDER BY created_at ASC, id ASC
  await db.schema
    .createIndex("idx_thread_messages_thread_created_id")
    .on("thread_messages")
    .columns(["thread_id", "created_at", "id"])
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  // Drop improved indexes
  await db.schema.dropIndex("idx_thread_messages_thread_created_id").execute();
  await db.schema.dropIndex("idx_threads_created_by_updated").execute();
  await db.schema.dropIndex("idx_threads_org_hidden_updated").execute();

  // Restore original indexes from migration 021
  await db.schema
    .createIndex("idx_threads_org")
    .on("threads")
    .columns(["organization_id"])
    .execute();

  await db.schema
    .createIndex("idx_threads_created_by")
    .on("threads")
    .columns(["created_by"])
    .execute();

  await db.schema
    .createIndex("idx_threads_org_updated")
    .on("threads")
    .columns(["organization_id", "updated_at"])
    .execute();

  await db.schema
    .createIndex("idx_thread_messages_thread")
    .on("thread_messages")
    .columns(["thread_id"])
    .execute();

  await db.schema
    .createIndex("idx_thread_messages_thread_created")
    .on("thread_messages")
    .columns(["thread_id", "created_at"])
    .execute();
}
