import { type Kysely, sql } from "kysely";

/**
 * Sprints the board owns, created and closed in Studio.
 *
 * The earlier `task_board_sprints` (migration 182) mirrored Jira's sprints
 * and was dropped with the mirror in 199. This one has no tracker identity:
 * every row is written by the sprint tools. Days are `date`, not
 * `timestamptz`, because a sprint runs from one calendar day to another
 * wherever its team is.
 *
 * `task_board_items.sprint_id` is nullable (a card with none is in the
 * backlog, which every existing card is) and `ON DELETE SET NULL`, so
 * deleting a sprint sends its cards to the backlog rather than deleting work.
 *
 * `ACTIONS` is migration 227's list plus `sprint_changed`, which 199 removed.
 * The CHECK is replaced wholesale, as 195, 199, 219 and 227 did.
 * `activity-actions.test.ts` reads this one, the newest, to prove SQL and
 * TypeScript agree.
 */
export const ACTIONS = [
  "created",
  "status_changed",
  "assignee_changed",
  "priority_changed",
  "due_date_changed",
  "title_changed",
  "description_changed",
  "tags_changed",
  "review_requested",
  "review_approved",
  "review_changes_requested",
  "review_verdict_requested",
  "merge_conflict_resolution",
  "merge_failed",
  "type_changed",
  "duplicate_reported",
  "finding_resolved",
  "sprint_changed",
] as const;

const PREVIOUS_ACTIONS = ACTIONS.filter((a) => a !== "sprint_changed");

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    CREATE TABLE task_board_sprints (
      id text PRIMARY KEY,
      organization_id text NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
      name text NOT NULL,
      state text NOT NULL DEFAULT 'future',
      start_date date,
      end_date date,
      created_by text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT chk_task_board_sprints_state
        CHECK (state IN ('future', 'active', 'closed')),
      CONSTRAINT chk_task_board_sprints_dates
        CHECK (start_date IS NULL OR end_date IS NULL OR end_date >= start_date)
    )
  `.execute(db);

  await sql`
    CREATE INDEX idx_task_board_sprints_org
      ON task_board_sprints (organization_id)
  `.execute(db);

  await sql`
    ALTER TABLE task_board_items
      ADD COLUMN sprint_id text REFERENCES task_board_sprints(id) ON DELETE SET NULL
  `.execute(db);

  // Partial: the backlog is most of most boards and is never read by sprint.
  await sql`
    CREATE INDEX idx_task_board_items_sprint
      ON task_board_items (organization_id, sprint_id)
      WHERE sprint_id IS NOT NULL
  `.execute(db);

  await replaceActivityActionCheck(db, ACTIONS);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DELETE FROM task_board_activity WHERE action = 'sprint_changed'`.execute(
    db,
  );
  await replaceActivityActionCheck(db, PREVIOUS_ACTIONS);
  await sql`DROP INDEX IF EXISTS idx_task_board_items_sprint`.execute(db);
  await sql`ALTER TABLE task_board_items DROP COLUMN IF EXISTS sprint_id`.execute(
    db,
  );
  await sql`DROP TABLE IF EXISTS task_board_sprints`.execute(db);
}

/** Swap `task_board_activity`'s action CHECK constraint for one allowing
 *  exactly `actions`. */
async function replaceActivityActionCheck(
  db: Kysely<unknown>,
  actions: readonly string[],
): Promise<void> {
  await sql`ALTER TABLE task_board_activity DROP CONSTRAINT chk_task_board_activity_action`.execute(
    db,
  );
  await sql`ALTER TABLE task_board_activity ADD CONSTRAINT chk_task_board_activity_action CHECK (action IN (${sql.join(
    actions.map((a) => sql.lit(a)),
  )}))`.execute(db);
}
