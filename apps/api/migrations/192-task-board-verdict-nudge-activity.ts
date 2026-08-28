import { type Kysely, sql } from "kysely";

/** Migration 180's action list, plus `review_verdict_requested` — recorded when
 *  a reviewer run that ended without a decision is asked for one. Frozen
 *  snapshot: the constraint is replaced wholesale because 180 may already be
 *  live, so editing its list in place wouldn't reach a deployed database.
 *  `activity-actions.test.ts` reads this one (the newest) to prove SQL and
 *  TypeScript agree. */
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
] as const;

const NEW_ACTIONS = new Set(["review_verdict_requested"]);

export async function up(db: Kysely<unknown>): Promise<void> {
  await replaceActivityActionCheck(db, ACTIONS);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await replaceActivityActionCheck(
    db,
    ACTIONS.filter((a) => !NEW_ACTIONS.has(a)),
  );
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
