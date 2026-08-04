import { sql, type Kysely } from "kysely";

/**
 * Introduce selector-independent routing authority for threads.
 *
 * This is the expand half of the routing-lock migration: existing selectors
 * remain in place and continue to drive reads, while every historical thread
 * with evidence of execution is conservatively locked. Retired or malformed
 * selector tuples are also marked ineligible for hosted execution so the
 * later switch cannot accidentally make them claimable.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .alterTable("threads")
    .addColumn("routing_locked_at", "timestamptz")
    .addColumn("hosted_execution_disabled_at", "timestamptz")
    .execute();

  // The timestamp is an authority marker, not a reconstructed audit event.
  // Use the database clock rather than casting legacy text timestamps: old
  // rows only need to stay locked, even if their historical dates are bad.
  await sql`
    UPDATE threads AS thread
    SET routing_locked_at = now()
    WHERE routing_locked_at IS NULL
      AND (
        thread.harness_id IS NOT NULL
        OR thread.sandbox_provider_kind IS NOT NULL
        OR thread.status <> 'completed'
        OR thread.context_start_message_id IS NOT NULL
        OR thread.run_owner_pod IS NOT NULL
        OR thread.run_config IS NOT NULL
        OR thread.run_started_at IS NOT NULL
        OR thread.last_progress_at IS NOT NULL
        OR thread.inflight_async_jobs IS NOT NULL
        OR thread.run_fence_token IS NOT NULL
        OR thread.cancel_requested_at IS NOT NULL
        OR thread.failure_reason IS NOT NULL
        OR thread.failure_kind IS NOT NULL
        OR thread.run_acked_seq IS NOT NULL
        OR EXISTS (
          SELECT 1
          FROM thread_messages AS message
          WHERE message.thread_id = thread.id
        )
        OR EXISTS (
          SELECT 1
          FROM thread_message_parts AS part
          WHERE part.thread_id = thread.id
        )
      )
  `.execute(db);

  await sql`
    UPDATE threads
    SET hosted_execution_disabled_at = now()
    WHERE hosted_execution_disabled_at IS NULL
      AND CASE
        WHEN harness_id IS NULL AND sandbox_provider_kind IS NULL THEN false
        WHEN harness_id IS NULL
          AND sandbox_provider_kind = 'agent-sandbox' THEN false
        WHEN harness_id = 'decopilot'
          AND sandbox_provider_kind = 'agent-sandbox' THEN false
        ELSE true
      END
  `.execute(db);

  // Keep old and new application pods interoperable during the rolling
  // switch. The durable lock is the new authority, but expand-version readers
  // still inspect the selectors. Canonicalize every enabled locked thread only
  // after incompatible historical tuples have been tombstoned above.
  await sql`
    UPDATE threads
    SET
      harness_id = 'decopilot',
      sandbox_provider_kind = 'agent-sandbox'
    WHERE routing_locked_at IS NOT NULL
      AND hosted_execution_disabled_at IS NULL
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .alterTable("threads")
    .dropColumn("hosted_execution_disabled_at")
    .dropColumn("routing_locked_at")
    .execute();
}
