import { type Kysely, sql } from "kysely";

/**
 * A trigger that fires when a card enters a board column.
 *
 * `column_key` is the lane the card entered. `from_kind` / `from_statuses`
 * say which moves count, by where the card came from — the same shape the Jira
 * column rules use (`any`, `earlier`, `later`, or a list of statuses).
 *
 * `automation_trigger_fires` claims one fire per (trigger, event), so a card
 * move that two replicas see, or that a sweep sees twice, starts one run. The
 * event key for a board move is its `status_changed` activity id.
 *
 * The partial index serves the sweep that reads recent moves across orgs.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    ALTER TABLE automation_triggers
      ADD COLUMN column_key text,
      ADD COLUMN from_kind text,
      ADD COLUMN from_statuses text[] NOT NULL DEFAULT '{}'
  `.execute(db);
  await sql`ALTER TABLE automation_triggers DROP CONSTRAINT chk_trigger_type`.execute(
    db,
  );
  await sql`
    ALTER TABLE automation_triggers ADD CONSTRAINT chk_trigger_type
      CHECK (type IN ('cron', 'event', 'webhook', 'board_column_transition'))
  `.execute(db);
  await sql`
    ALTER TABLE automation_triggers ADD CONSTRAINT chk_board_column_transition_trigger
      CHECK (
        type != 'board_column_transition'
        OR (column_key IS NOT NULL
            AND from_kind IN ('any', 'earlier', 'later', 'statuses'))
      )
  `.execute(db);

  await sql`
    CREATE TABLE automation_trigger_fires (
      trigger_id text NOT NULL REFERENCES automation_triggers(id) ON DELETE CASCADE,
      event_key text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (trigger_id, event_key)
    )
  `.execute(db);

  await sql`
    CREATE INDEX IF NOT EXISTS idx_task_board_activity_status_changed_at
      ON task_board_activity (occurred_at)
      WHERE action = 'status_changed'
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP INDEX IF EXISTS idx_task_board_activity_status_changed_at`.execute(
    db,
  );
  await sql`DROP TABLE IF EXISTS automation_trigger_fires`.execute(db);
  await sql`DELETE FROM automation_triggers WHERE type = 'board_column_transition'`.execute(
    db,
  );
  await sql`ALTER TABLE automation_triggers DROP CONSTRAINT IF EXISTS chk_board_column_transition_trigger`.execute(
    db,
  );
  await sql`ALTER TABLE automation_triggers DROP CONSTRAINT chk_trigger_type`.execute(
    db,
  );
  await sql`
    ALTER TABLE automation_triggers ADD CONSTRAINT chk_trigger_type
      CHECK (type IN ('cron', 'event', 'webhook'))
  `.execute(db);
  await sql`
    ALTER TABLE automation_triggers
      DROP COLUMN IF EXISTS column_key,
      DROP COLUMN IF EXISTS from_kind,
      DROP COLUMN IF EXISTS from_statuses
  `.execute(db);
}
