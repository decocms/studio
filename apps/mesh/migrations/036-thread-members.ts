/**
 * Thread Members Migration
 *
 * Creates the thread_members join table for sharing threads with org members.
 * A thread owner can add members who get read-only access to the thread.
 */

import { Kysely } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable("thread_members")
    .addColumn("thread_id", "text", (col) =>
      col.notNull().references("threads.id").onDelete("cascade"),
    )
    .addColumn("user_id", "text", (col) => col.notNull())
    .addColumn("added_by", "text", (col) => col.notNull())
    .addColumn("added_at", "text", (col) => col.notNull())
    .execute();

  await db.schema
    .createIndex("thread_members_unique")
    .on("thread_members")
    .columns(["thread_id", "user_id"])
    .unique()
    .execute();

  await db.schema
    .createIndex("thread_members_thread_id_idx")
    .on("thread_members")
    .columns(["thread_id"])
    .execute();

  await db.schema
    .createIndex("thread_members_user_id_idx")
    .on("thread_members")
    .columns(["user_id"])
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropIndex("thread_members_user_id_idx").execute();
  await db.schema.dropIndex("thread_members_thread_id_idx").execute();
  await db.schema.dropIndex("thread_members_unique").execute();
  await db.schema.dropTable("thread_members").execute();
}
