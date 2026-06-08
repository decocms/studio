import { sql, type Kysely } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable("thread_message_parts")
    .addColumn("id", "text", (c) => c.primaryKey()) // "<run_id>:<seq>"
    .addColumn("seq", "integer", (c) => c.notNull()) // monotonic per run
    .addColumn("org_id", "text", (c) => c.notNull())
    .addColumn("thread_id", "text", (c) =>
      c.notNull().references("threads.id").onDelete("cascade"),
    )
    .addColumn("run_id", "text", (c) => c.notNull())
    .addColumn("message_id", "text", (c) => c.notNull())
    .addColumn("role", "text", (c) => c.notNull())
    .addColumn("kind", "text", (c) => c.notNull())
    .addColumn("payload", "jsonb", (c) => c.notNull())
    .addColumn("payload_ref", "text")
    .addColumn("metadata", "jsonb")
    .addColumn("created_at", "text", (c) => c.notNull())
    .execute();

  await sql`CREATE UNIQUE INDEX idx_tmp_run_seq ON thread_message_parts (run_id, seq)`.execute(
    db,
  );
  await sql`CREATE INDEX idx_tmp_thread_created_id ON thread_message_parts (thread_id, created_at, id)`.execute(
    db,
  );
  await sql`CREATE INDEX idx_tmp_finish_anchor ON thread_message_parts (thread_id, created_at DESC, id DESC) WHERE kind = 'finish'`.execute(
    db,
  );
  await sql`CREATE INDEX idx_tmp_message ON thread_message_parts (thread_id, message_id)`.execute(
    db,
  );

  await db.schema
    .alterTable("threads")
    .addColumn("message_storage_version", "integer", (c) =>
      c.notNull().defaultTo(1),
    )
    .addColumn("last_progress_at", "timestamptz")
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .alterTable("threads")
    .dropColumn("message_storage_version")
    .dropColumn("last_progress_at")
    .execute();
  await db.schema.dropTable("thread_message_parts").ifExists().execute();
}
