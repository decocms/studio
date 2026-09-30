import { type Kysely, sql } from "kysely";

/**
 * `POST /api/:org/internal/task-board/resolve` lets the reports engine say
 * that the Deco Score check behind a card passes now. Each card it names gets
 * a `finding_resolved` entry on its timeline. The entry's data holds the
 * source `url`, the engine's `run_id`, and whether that call `closed` the card.
 *
 * `ACTIONS` is migration 219's list plus `finding_resolved`. This replaces the
 * CHECK wholesale, as 195, 199 and 219 did, because the older constraint may
 * be live. `activity-actions.test.ts` reads this one, the newest, to prove SQL
 * and TypeScript agree.
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
] as const;

const PREVIOUS_ACTIONS = ACTIONS.filter((a) => a !== "finding_resolved");

export async function up(db: Kysely<unknown>): Promise<void> {
  await replaceActivityActionCheck(db, ACTIONS);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DELETE FROM task_board_activity WHERE action = 'finding_resolved'`.execute(
    db,
  );
  await replaceActivityActionCheck(db, PREVIOUS_ACTIONS);
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
