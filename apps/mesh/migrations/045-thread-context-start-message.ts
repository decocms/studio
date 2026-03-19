/**
 * Thread Context Start Message Migration
 *
 * Adds `context_start_message_id` to threads for plan mode context truncation.
 * When set, message loading starts from this message instead of full history.
 */

import { Kysely } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .alterTable("threads")
    .addColumn("context_start_message_id", "text")
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .alterTable("threads")
    .dropColumn("context_start_message_id")
    .execute();
}
