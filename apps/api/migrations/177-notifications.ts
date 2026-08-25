import { type Kysely, sql } from "kysely";

/**
 * Follow/inbox for the task board: who follows what, and one row per recipient
 * per event.
 *
 * `notifications` carries its own `organization_id` so no read ever infers the
 * tenant from a join, and its `data` jsonb carries everything the inbox row
 * renders — so the read touches exactly one table, and a second subject type
 * (a thread, say) is a nullable column that leaves the read query alone.
 *
 * `subscribed boolean` rather than row-presence: auto-subscribe must not
 * resurrect a task you explicitly unfollowed, so "no row" and "row with
 * subscribed = false" are different states.
 *
 * A frozen snapshot of the type list, like the activity actions'
 * (`169-task-board-merge-failed-activity.ts`); `notification-types.test.ts`
 * binds it to `NOTIFICATION_TYPES`.
 */
export const TYPES = [
  "created",
  "commented",
  "status_changed",
  "assignee_changed",
  "review_requested",
  "review_approved",
  "review_changes_requested",
  "merge_failed",
] as const;

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable("notification_subscriptions")
    .addColumn("id", "text", (col) => col.primaryKey())
    .addColumn("user_id", "text", (col) =>
      col.notNull().references("user.id").onDelete("cascade"),
    )
    .addColumn("task_board_item_id", "text", (col) =>
      col.notNull().references("task_board_items.id").onDelete("cascade"),
    )
    .addColumn("subscribed", "boolean", (col) => col.notNull().defaultTo(true))
    .addColumn("created_at", "timestamptz", (col) =>
      col.notNull().defaultTo(sql`now()`),
    )
    .addColumn("updated_at", "timestamptz", (col) =>
      col.notNull().defaultTo(sql`now()`),
    )
    .addUniqueConstraint("notification_subscriptions_user_item", [
      "user_id",
      "task_board_item_id",
    ])
    .execute();

  await db.schema
    .createTable("notifications")
    .addColumn("id", "text", (col) => col.primaryKey())
    .addColumn("user_id", "text", (col) =>
      col.notNull().references("user.id").onDelete("cascade"),
    )
    .addColumn("organization_id", "text", (col) =>
      col.notNull().references("organization.id").onDelete("cascade"),
    )
    .addColumn("task_board_item_id", "text", (col) =>
      col.notNull().references("task_board_items.id").onDelete("cascade"),
    )
    .addColumn("type", "text", (col) => col.notNull())
    .addColumn("actor_id", "text", (col) =>
      col.references("user.id").onDelete("set null"),
    )
    .addColumn("data", "jsonb", (col) => col.notNull())
    .addColumn("read_at", "timestamptz")
    .addColumn("emailed_at", "timestamptz")
    .addColumn("created_at", "timestamptz", (col) =>
      col.notNull().defaultTo(sql`now()`),
    )
    .addCheckConstraint(
      "notifications_type_check",
      sql`type IN (${sql.join(TYPES.map((t) => sql.lit(t)))})`,
    )
    .execute();

  /** The inbox read and its unread count: both equalities, then the ORDER BY. */
  await sql`CREATE INDEX notifications_user_unread ON notifications
    (user_id, organization_id, created_at DESC) WHERE read_at IS NULL`.execute(
    db,
  );

  /** Exactly the digest's predicate — read rows leave the index. */
  await sql`CREATE INDEX notifications_digest ON notifications
    (created_at) WHERE emailed_at IS NULL AND read_at IS NULL`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable("notifications").execute();
  await db.schema.dropTable("notification_subscriptions").execute();
}
