import { sql, type Kysely } from "kysely";

/**
 * Repair selector-only rows written by pre-expand pods after migration 158.
 *
 * A database compatibility trigger closes the rolling-deploy window: once
 * this migration starts, selector-only writes from an older pod are converted
 * to the same immutable authority markers as expand-version writes. The bulk
 * repair then catches every row committed before the trigger acquired its
 * table lock, so switch-version readers never depend on deployment timing.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    CREATE OR REPLACE FUNCTION sync_thread_routing_authority_from_legacy()
    RETURNS trigger
    LANGUAGE plpgsql
    AS $function$
    BEGIN
      -- Once claimed or disabled, routing authority cannot be cleared by a
      -- selector-era writer that does not know about the new columns.
      IF TG_OP = 'UPDATE' THEN
        IF OLD.routing_locked_at IS NOT NULL THEN
          NEW.routing_locked_at := OLD.routing_locked_at;
        END IF;
        IF OLD.hosted_execution_disabled_at IS NOT NULL THEN
          NEW.hosted_execution_disabled_at := OLD.hosted_execution_disabled_at;
        END IF;
      END IF;

      -- Legacy application versions claim routing by writing one or both
      -- selectors. Other lifecycle fields are historical repair evidence, not
      -- live authority: a new selector-free draft may legitimately carry them
      -- before its first hosted submit.
      IF NEW.routing_locked_at IS NULL
        AND (
          NEW.harness_id IS NOT NULL
          OR NEW.sandbox_provider_kind IS NOT NULL
        )
      THEN
        NEW.routing_locked_at := now();
      END IF;

      IF NEW.hosted_execution_disabled_at IS NULL
        AND (
          CASE
            WHEN NEW.harness_id IS NULL
              AND NEW.sandbox_provider_kind IS NULL THEN false
            WHEN NEW.harness_id IS NULL
              AND NEW.sandbox_provider_kind = 'agent-sandbox' THEN false
            WHEN NEW.harness_id = 'decopilot'
              AND NEW.sandbox_provider_kind = 'agent-sandbox' THEN false
            ELSE true
          END
        )
      THEN
        NEW.hosted_execution_disabled_at := now();
      END IF;

      -- Expand-version readers still require the legacy tuple. Preserve that
      -- representation until the later contract migration removes it.
      IF NEW.routing_locked_at IS NOT NULL
        AND NEW.hosted_execution_disabled_at IS NULL
      THEN
        NEW.harness_id := 'decopilot';
        NEW.sandbox_provider_kind := 'agent-sandbox';
      END IF;

      RETURN NEW;
    END;
    $function$;
  `.execute(db);

  await sql`
    DROP TRIGGER IF EXISTS threads_legacy_routing_authority ON threads
  `.execute(db);
  await sql`
    CREATE TRIGGER threads_legacy_routing_authority
    BEFORE INSERT OR UPDATE ON threads
    FOR EACH ROW
    EXECUTE FUNCTION sync_thread_routing_authority_from_legacy()
  `.execute(db);

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

  // Old pods require the tuple while switch-version pods require the lock.
  // Keep both representations aligned until the later contract migration.
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
  await sql`
    DROP TRIGGER IF EXISTS threads_legacy_routing_authority ON threads
  `.execute(db);
  await sql`
    DROP FUNCTION IF EXISTS sync_thread_routing_authority_from_legacy()
  `.execute(db);

  // Authority markers are immutable and cannot be distinguished from values
  // written by migration 158 or by live expand-version application code.
}
