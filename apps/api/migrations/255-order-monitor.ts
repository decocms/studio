import { type Kysely, sql } from "kysely";

/** Migration 179's notification type list, plus `order_incident` — written when
 *  the order monitor opens, escalates or closes an incident card. A frozen
 *  snapshot; `notification-types.test.ts` reads this one (the newest). */
export const TYPES = [
  "created",
  "commented",
  "mentioned",
  "status_changed",
  "assignee_changed",
  "review_requested",
  "review_approved",
  "review_changes_requested",
  "merge_failed",
  "order_incident",
] as const;

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable("order_monitor_state")
    .addColumn("organization_id", "text", (col) => col.notNull())
    .addColumn("connection_id", "text", (col) =>
      col.notNull().references("connections.id").onDelete("cascade"),
    )
    .addColumn("rule", "text", (col) => col.notNull())
    .addColumn("status", "text", (col) => col.notNull())
    .addColumn("since", "timestamptz", (col) => col.notNull())
    .addColumn("evaluated_at", "timestamptz", (col) => col.notNull())
    .addColumn("verdict", "jsonb", (col) => col.notNull())
    // The open incident's card. A person deleting it clears the link; the
    // next transition into warning/alert opens a new one.
    .addColumn("task_board_item_id", "text", (col) =>
      col.references("task_board_items.id").onDelete("set null"),
    )
    .addPrimaryKeyConstraint("order_monitor_state_pkey", [
      "organization_id",
      "connection_id",
      "rule",
    ])
    .execute();
  await replaceNotificationTypeCheck(db, TYPES);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DELETE FROM notifications WHERE type = 'order_incident'`.execute(
    db,
  );
  await replaceNotificationTypeCheck(
    db,
    TYPES.filter((t) => t !== "order_incident"),
  );
  await db.schema.dropTable("order_monitor_state").ifExists().execute();
}

async function replaceNotificationTypeCheck(
  db: Kysely<unknown>,
  types: readonly string[],
): Promise<void> {
  await sql`ALTER TABLE notifications DROP CONSTRAINT notifications_type_check`.execute(
    db,
  );
  await sql`ALTER TABLE notifications ADD CONSTRAINT notifications_type_check CHECK (type IN (${sql.join(
    types.map((t) => sql.lit(t)),
  )}))`.execute(db);
}
