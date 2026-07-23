/**
 * First-class table for async research jobs (Gemini Deep Research et al).
 *
 * Replaces the `threads.inflight_async_jobs` JSONB array. The JSONB column
 * stays in place for now — a later migration drops it once all writers have
 * moved to this table.
 *
 * Lifecycle is encoded explicitly in the `status` column so debugging is one
 * SQL query: `SELECT * FROM async_research_jobs WHERE thread_id = ?`. No
 * silent read-side TTL — abandoned rows are flipped to status='abandoned'
 * by a periodic sweeper, which keeps them queryable in the audit trail.
 *
 * Idempotency: UNIQUE(organization_id, tool_call_id). A DBOS step replay
 * for the same tool call must find the existing row instead of spawning a
 * fresh job at the provider.
 */
import { type Kysely, sql } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable("async_research_jobs")
    // identity
    .addColumn("id", "uuid", (col) =>
      col.primaryKey().defaultTo(sql`gen_random_uuid()`),
    )
    .addColumn("interaction_id", "text")
    .addColumn("tool_call_id", "text", (col) => col.notNull())

    // scoping
    .addColumn("organization_id", "text", (col) => col.notNull())
    .addColumn("thread_id", "text", (col) => col.notNull())
    .addColumn("message_id", "text")

    // request
    .addColumn("provider", "text", (col) => col.notNull())
    .addColumn("model_id", "text", (col) => col.notNull())
    .addColumn("query", "text", (col) => col.notNull())

    // lifecycle
    .addColumn("status", "text", (col) => col.notNull())
    .addColumn("attempts", "integer", (col) => col.notNull().defaultTo(0))
    .addColumn("last_polled_at", "timestamptz")
    .addColumn("last_error", "text")

    // result
    .addColumn("input_tokens", "integer")
    .addColumn("output_tokens", "integer")
    .addColumn("citations", "jsonb")
    .addColumn("result_uri", "text")
    .addColumn("result_preview", "text")

    // timestamps
    .addColumn("created_at", "timestamptz", (col) =>
      col.notNull().defaultTo(sql`now()`),
    )
    .addColumn("updated_at", "timestamptz", (col) =>
      col.notNull().defaultTo(sql`now()`),
    )
    .addColumn("completed_at", "timestamptz")
    .execute();

  // Idempotency on (org, tool_call_id) — DBOS replay must hit the same row.
  await db.schema
    .createIndex("async_research_jobs_org_tool_call_unique")
    .on("async_research_jobs")
    .columns(["organization_id", "tool_call_id"])
    .unique()
    .execute();

  // Per-thread history, newest first. Driving query for "what happened to
  // this customer's research job".
  await db.schema
    .createIndex("async_research_jobs_thread_created_idx")
    .on("async_research_jobs")
    .columns(["thread_id", "created_at desc"])
    .execute();

  // Sweeper query: WHERE status IN ('pending','polling') AND last_polled_at <
  // now() - interval '1h'. Partial index keeps it tiny since most rows are
  // terminal.
  await sql`
    CREATE INDEX async_research_jobs_active_idx
    ON async_research_jobs (status, last_polled_at)
    WHERE status IN ('pending', 'polling')
  `.execute(db);

  // "I have a Gemini interaction id from a log, what is it?" lookup.
  await db.schema
    .createIndex("async_research_jobs_interaction_idx")
    .on("async_research_jobs")
    .column("interaction_id")
    .execute();

  // Belt-and-braces: keep status values constrained at the DB layer so an
  // inconsistent row can't be written even outside the application layer.
  await sql`
    ALTER TABLE async_research_jobs
    ADD CONSTRAINT chk_async_research_jobs_status
    CHECK (status IN ('pending','polling','completed','failed','cancelled','abandoned'))
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable("async_research_jobs").ifExists().execute();
}
