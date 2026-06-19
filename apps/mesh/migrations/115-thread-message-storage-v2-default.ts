import { sql, type Kysely } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    ALTER TABLE threads
    ALTER COLUMN message_storage_version SET DEFAULT 2
  `.execute(db);

  await sql`
    UPDATE threads
    SET message_storage_version = 2
    WHERE message_storage_version = 1
      AND NOT EXISTS (
        SELECT 1
        FROM thread_messages
        WHERE thread_messages.thread_id = threads.id
      )
      AND NOT EXISTS (
        SELECT 1
        FROM thread_message_parts
        WHERE thread_message_parts.thread_id = threads.id
      )
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`
    ALTER TABLE threads
    ALTER COLUMN message_storage_version SET DEFAULT 1
  `.execute(db);
}
