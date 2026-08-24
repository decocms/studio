import { type Kysely, sql } from "kysely";

/**
 * Task subscriptions — who follows a task, and how far each follower has been
 * caught up. Notifications themselves are NOT stored: the inbox and the email
 * digest are both a join of these two tables over `task_board_activity`, which
 * every code path already writes.
 *
 * Two invariants live in the schema rather than in code:
 *
 *   - A `subscribed = false` row is a STICKY opt-out. Auto-subscribe (creator,
 *     assignee, commenter) inserts with `on conflict do nothing`, so no
 *     automatic rule can ever resurrect someone who deliberately left.
 *   - `task_board_subscribers.created_at` is the notification floor: a
 *     subscriber is never told about activity that predates their subscription.
 *     That is what makes a NULL cursor harmless — a first-time reader sees an
 *     empty inbox, not the task's whole history.
 *
 * Migration 156's action list, plus `commented`, so a comment is one more
 * activity row and `task_board_activity` stays the single source both surfaces
 * read (no UNION with `task_board_comments`). The CHECK constraint is replaced
 * wholesale — 169 is already live, so editing its list in place wouldn't reach
 * a deployed database. A frozen snapshot like its predecessors;
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
  "merge_conflict_resolution",
  "merge_failed",
  "commented",
] as const;

const NEW_ACTIONS = new Set<string>(["commented"]);

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable("task_board_subscribers")
    .addColumn("task_board_item_id", "text", (col) =>
      col.notNull().references("task_board_items.id").onDelete("cascade"),
    )
    .addColumn("user_id", "text", (col) =>
      col.notNull().references("user.id").onDelete("cascade"),
    )
    // false = opted out; the row survives so auto-subscribe can't undo it.
    .addColumn("subscribed", "boolean", (col) => col.notNull().defaultTo(true))
    .addColumn("created_at", "timestamptz", (col) =>
      col.notNull().defaultTo(sql`now()`),
    )
    .addColumn("updated_at", "timestamptz", (col) =>
      col.notNull().defaultTo(sql`now()`),
    )
    .addPrimaryKeyConstraint("task_board_subscribers_pkey", [
      "task_board_item_id",
      "user_id",
    ])
    .execute();

  // "What am I subscribed to" drives both surfaces; user_id doesn't prefix the PK.
  await db.schema
    .createIndex("idx_task_board_subscribers_user")
    .on("task_board_subscribers")
    .column("user_id")
    .execute();

  /**
   * How far each (user, org) has been caught up. `last_read_at` clears the
   * inbox dot; `last_emailed_at` doubles as the digest's compare-and-set claim,
   * which is what keeps N pods from sending N copies of one digest.
   */
  await db.schema
    .createTable("task_notification_cursors")
    .addColumn("user_id", "text", (col) =>
      col.notNull().references("user.id").onDelete("cascade"),
    )
    .addColumn("organization_id", "text", (col) =>
      col.notNull().references("organization.id").onDelete("cascade"),
    )
    .addColumn("last_read_at", "timestamptz")
    .addColumn("last_emailed_at", "timestamptz")
    .addColumn("created_at", "timestamptz", (col) =>
      col.notNull().defaultTo(sql`now()`),
    )
    .addColumn("updated_at", "timestamptz", (col) =>
      col.notNull().defaultTo(sql`now()`),
    )
    .addPrimaryKeyConstraint("task_notification_cursors_pkey", [
      "user_id",
      "organization_id",
    ])
    .execute();

  /**
   * The PK covers lookups by (user, org), but organization_id is not a usable
   * prefix of it — without this, deleting an org sequentially scans this table
   * to enforce the cascade.
   */
  await db.schema
    .createIndex("task_notification_cursors_organization_id_idx")
    .on("task_notification_cursors")
    .column("organization_id")
    .execute();

  await replaceActivityActionCheck(db, ACTIONS);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await replaceActivityActionCheck(
    db,
    ACTIONS.filter((a) => !NEW_ACTIONS.has(a)),
  );
  await db.schema.dropTable("task_notification_cursors").execute();
  await db.schema.dropIndex("idx_task_board_subscribers_user").execute();
  await db.schema.dropTable("task_board_subscribers").execute();
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
