import { type Kysely, sql } from "kysely";

/**
 * `TASK_BOARD_ITEM_CREATE` with `onDuplicate: "return_existing"` hands back the
 * card that already tracks the drafted work instead of opening a second one.
 * The second filing is recorded on that card's timeline as
 * `duplicate_reported` (data: the drafted `title` and the model's `reason`),
 * so the ask is not lost and a reader can see it arrived twice.
 *
 * `ACTIONS` is migration 199's list plus `duplicate_reported`. The CHECK is
 * replaced wholesale, as 195 and 199 did, because the older constraint may be
 * live. `activity-actions.test.ts` reads this one (the newest) to prove SQL
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
] as const;

const PREVIOUS_ACTIONS = ACTIONS.filter((a) => a !== "duplicate_reported");

export async function up(db: Kysely<unknown>): Promise<void> {
  await replaceActivityActionCheck(db, ACTIONS);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DELETE FROM task_board_activity WHERE action = 'duplicate_reported'`.execute(
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
