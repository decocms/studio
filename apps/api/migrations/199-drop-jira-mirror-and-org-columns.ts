import { type Kysely, sql } from "kysely";

const CANONICAL_COLUMN_KEYS = [
  "triage",
  "todo",
  "in_progress",
  "in_review",
  "approved",
  "merged",
  "post_deploy_validation",
  "done",
  "archived",
];

/**
 * The Jira integration stops mirroring cards, and the board goes back to being
 * Studio's own.
 *
 * Both features shared one premise — a tracker's card has a row here — and it
 * is the premise that goes. What stays is the integration's credential and
 * board choice (`org_jira_integrations`), which the run trigger keeps using,
 * and `task_board_item_jira_links`, reduced to the issue ↔ item mapping a run
 * is anchored on. Everything that only made sense while cards were copied
 * both ways is dropped: the sync watermark and rescan flag, the status
 * mapping, the mirrored sprints, the comment links, and the org-owned column
 * set with its FK on `task_board_items`.
 *
 * `ACTIONS` is migration 195's list minus `sprint_changed`. The CHECK is
 * replaced wholesale, as 195 did, because the older constraint may be live.
 * `activity-actions.test.ts` reads this one (the newest) to prove SQL and
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
] as const;

export async function up(db: Kysely<unknown>): Promise<void> {
  // Org-owned columns: the FK and CHECK on items first, then the table.
  await sql`ALTER TABLE task_board_items DROP CONSTRAINT IF EXISTS task_board_items_board_column_fkey`.execute(
    db,
  );
  await sql`ALTER TABLE task_board_items DROP CONSTRAINT IF EXISTS chk_task_board_items_column_org`.execute(
    db,
  );
  await sql`ALTER TABLE task_board_items DROP COLUMN IF EXISTS board_column_org`.execute(
    db,
  );
  await sql`DROP TABLE IF EXISTS task_board_columns`.execute(db);
  // A card filed under a column of the org's own has no column any more. Back
  // to intake rather than deleted: the row still carries its runs and PRs.
  await sql`
    UPDATE task_board_items
       SET status = 'triage'
     WHERE status NOT IN (${sql.join(CANONICAL_COLUMN_KEYS.map((k) => sql.lit(k)))})
  `.execute(db);

  // Mirrored sprints.
  await sql`DROP INDEX IF EXISTS idx_task_board_items_sprint`.execute(db);
  await sql`ALTER TABLE task_board_items DROP COLUMN IF EXISTS sprint_id`.execute(
    db,
  );
  await sql`DROP TABLE IF EXISTS task_board_sprints`.execute(db);
  await replaceActivityActionCheck(db, ACTIONS);

  // Comment mirroring and the per-link sync state.
  await sql`DROP TABLE IF EXISTS task_board_comment_jira_links`.execute(db);
  await sql`
    ALTER TABLE task_board_item_jira_links
      DROP COLUMN IF EXISTS jira_updated_at,
      DROP COLUMN IF EXISTS jira_status,
      DROP COLUMN IF EXISTS jira_sprint_id
  `.execute(db);

  // Sync configuration and state on the integration row.
  await sql`
    ALTER TABLE org_jira_integrations
      DROP COLUMN IF EXISTS status_mapping,
      DROP COLUMN IF EXISTS auto_delegate,
      DROP COLUMN IF EXISTS last_synced_at,
      DROP COLUMN IF EXISTS last_sync_error,
      DROP COLUMN IF EXISTS rescan_pending
  `.execute(db);
}

export async function down(): Promise<void> {
  // The mirrored data is gone; recreating the empty shapes would only invite a
  // deploy of the removed code. Restore by re-running 171–196 on a fresh db.
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
