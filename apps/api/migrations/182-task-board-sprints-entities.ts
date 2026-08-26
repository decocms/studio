import { type Kysely, sql } from "kysely";

/**
 * Sprints become rows instead of windows over a cadence.
 *
 * Migration 175 derived a sprint from `organization_settings.sprint_config`
 * (`{ enabled, weeks, startDate }`): sprint N was the Nth fixed-length window
 * since a start date, and a card carried only the NUMBER. That can only
 * describe a team whose sprints never slip, are never renamed, and all last
 * the same number of weeks — which no Jira board is. A sprint in Jira is an
 * entity with a name, a state and its own dates, and it is the axis people
 * actually use to read a board, so the mirror has to carry the entity.
 *
 * Today every sprint row comes from the Jira pull (`jira_sprint_id` set,
 * UNIQUE per org so re-imports update in place). The column is nullable so a
 * board without Jira can own its own sprints later without another migration;
 * nothing writes those yet.
 *
 * `state` is Jira's own vocabulary rather than a derived "is it today":
 * `sprintNumberAt`-style date math disagreed with the board whenever a team
 * started a sprint late, and the board is the thing we are mirroring.
 *
 * `task_board_items.sprint_id` replaces `task_board_items.sprint`. Dropped
 * outright, along with `sprint_config`: no card in any org has ever carried a
 * sprint number, so there is nothing to convert and a backfill would be
 * inventing data. `ON DELETE SET NULL` — deleting a sprint sends its cards to
 * the backlog, it does not delete work.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    CREATE TABLE task_board_sprints (
      id text PRIMARY KEY,
      organization_id text NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
      name text NOT NULL,
      state text NOT NULL DEFAULT 'future',
      starts_at timestamptz,
      ends_at timestamptz,
      jira_sprint_id text,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT chk_task_board_sprints_state
        CHECK (state IN ('active', 'future', 'closed')),
      UNIQUE (organization_id, jira_sprint_id)
    )
  `.execute(db);

  // One org's whole sprint list, in the order they run — the filter's options.
  await sql`
    CREATE INDEX idx_task_board_sprints_org
      ON task_board_sprints (organization_id, starts_at)
  `.execute(db);

  await sql`
    ALTER TABLE task_board_items
      ADD COLUMN sprint_id text REFERENCES task_board_sprints(id) ON DELETE SET NULL
  `.execute(db);

  // Partial: the backlog is most of most boards, and is never looked up by sprint.
  await sql`
    CREATE INDEX idx_task_board_items_sprint
      ON task_board_items (organization_id, sprint_id)
      WHERE sprint_id IS NOT NULL
  `.execute(db);

  await db.schema.alterTable("task_board_items").dropColumn("sprint").execute();
  await db.schema
    .alterTable("organization_settings")
    .dropColumn("sprint_config")
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .alterTable("organization_settings")
    .addColumn("sprint_config", "jsonb")
    .execute();
  await db.schema
    .alterTable("task_board_items")
    .addColumn("sprint", "integer")
    .execute();
  await sql`DROP INDEX IF EXISTS idx_task_board_items_sprint`.execute(db);
  await db.schema
    .alterTable("task_board_items")
    .dropColumn("sprint_id")
    .execute();
  await sql`DROP TABLE IF EXISTS task_board_sprints`.execute(db);
}
