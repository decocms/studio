import { type Kysely, sql } from "kysely";

/** Migration 154's action list, plus `merge_conflict_resolution` — logged when
 *  an approved PR can't auto-merge because of a merge conflict and the task is
 *  handed back to the Super Agent to resolve it. The CHECK constraint is
 *  replaced wholesale — 154 may already be live, so editing its list in place
 *  wouldn't reach a deployed database. A frozen snapshot like its predecessors;
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
  "merge_conflict_resolution",
] as const;

const NEW_ACTIONS = new Set(["merge_conflict_resolution"]);

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
