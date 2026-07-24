/**
 * Threads Tables Migration
 *
 * Creates tables for chat threads and messages.
 * - threads: Chat conversation threads scoped to an organization
 * - thread_messages: Individual messages within a thread (user/assistant)
 *
 * Threads store AI chat conversations with message history for persistence
 * across sessions.
 */

import { Kysely, sql } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  // Create threads table
  // Chat conversation threads scoped to an organization
  await db.schema
    .createTable("threads")
    .addColumn("id", "text", (col) => col.primaryKey())
    // CASCADE DELETE: When organization is deleted, threads are automatically removed
    .addColumn("organization_id", "text", (col) =>
      col.notNull().references("organization.id").onDelete("cascade"),
    )
    .addColumn("title", "text", (col) => col.notNull())
    .addColumn("description", "text")
    .addColumn("hidden", "boolean", (col) => col.notNull().defaultTo(false))
    // Audit fields
    .addColumn("created_at", "text", (col) =>
      col.notNull().defaultTo(sql`CURRENT_TIMESTAMP`),
    )
    .addColumn("updated_at", "text", (col) =>
      col.notNull().defaultTo(sql`CURRENT_TIMESTAMP`),
    )
    .addColumn("created_by", "text", (col) =>
      col.notNull().references("user.id").onDelete("cascade"),
    )
    .addColumn("updated_by", "text")
    .execute();

  // Create thread_messages table
  // Individual messages within a thread
  await db.schema
    .createTable("thread_messages")
    .addColumn("id", "text", (col) => col.primaryKey())
    // CASCADE DELETE: When thread is deleted, messages are automatically removed
    .addColumn("thread_id", "text", (col) =>
      col.notNull().references("threads.id").onDelete("cascade"),
    )
    .addColumn("metadata", "text") // JSON object stored as text
    .addColumn("parts", "text", (col) => col.notNull()) // JSON array of message parts
    .addColumn("role", "text", (col) => col.notNull()) // "user" or "assistant"
    // Audit fields
    .addColumn("created_at", "text", (col) =>
      col.notNull().defaultTo(sql`CURRENT_TIMESTAMP`),
    )
    .addColumn("updated_at", "text", (col) =>
      col.notNull().defaultTo(sql`CURRENT_TIMESTAMP`),
    )
    .execute();

  // Indexes for threads table
  // Query by organization
  await db.schema
    .createIndex("idx_threads_org")
    .on("threads")
    .columns(["organization_id"])
    .execute();

  // Query by creator
  await db.schema
    .createIndex("idx_threads_created_by")
    .on("threads")
    .columns(["created_by"])
    .execute();

  // Query by organization and updated_at for recent threads
  await db.schema
    .createIndex("idx_threads_org_updated")
    .on("threads")
    .columns(["organization_id", "updated_at"])
    .execute();

  // Indexes for thread_messages table
  // Query messages by thread
  await db.schema
    .createIndex("idx_thread_messages_thread")
    .on("thread_messages")
    .columns(["thread_id"])
    .execute();

  // Query messages by thread ordered by creation time
  await db.schema
    .createIndex("idx_thread_messages_thread_created")
    .on("thread_messages")
    .columns(["thread_id", "created_at"])
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  // Drop indexes first
  await db.schema.dropIndex("idx_thread_messages_thread_created").execute();
  await db.schema.dropIndex("idx_thread_messages_thread").execute();
  await db.schema.dropIndex("idx_threads_org_updated").execute();
  await db.schema.dropIndex("idx_threads_created_by").execute();
  await db.schema.dropIndex("idx_threads_org").execute();

  // Drop tables in reverse order (respecting foreign keys)
  await db.schema.dropTable("thread_messages").execute();
  await db.schema.dropTable("threads").execute();
}
