import { type Kysely, sql } from "kysely";

/**
 * The actions the log accepts, enforced by a CHECK constraint so the DB — not
 * just `TaskBoardActivityAction` — rejects a typo'd action. Widening the set is
 * deliberately a new migration; keep this list in sync with that type.
 */
const ACTIONS = [
  "created",
  "status_changed",
  "assignee_changed",
  "priority_changed",
  "due_date_changed",
  "title_changed",
  "description_changed",
] as const;

/**
 * Task activity log — the "changes of the card" timeline (created, status
 * moved, (re)assigned), rendered in the task dialog's Activity feed alongside
 * the linked agent sessions. Append-only; one row per event: who did what,
 * when, plus a jsonb `data` payload ({from,to}).
 *
 * A null `actor_id` means no human did it — the agent/system moved the card (or
 * the actor's account was since deleted). No `organization_id`: the task it
 * hangs off is already org-scoped, and reads join through it.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable("task_board_activity")
    .addColumn("id", "text", (col) => col.primaryKey())
    .addColumn("task_board_item_id", "text", (col) =>
      col.notNull().references("task_board_items.id").onDelete("cascade"),
    )
    .addColumn("action", "text", (col) => col.notNull())
    .addColumn("actor_id", "text", (col) =>
      col.references("user.id").onDelete("set null"),
    )
    .addColumn("data", "jsonb")
    .addColumn("occurred_at", "timestamptz", (col) =>
      col.notNull().defaultTo(sql`now()`),
    )
    .addCheckConstraint(
      "chk_task_board_activity_action",
      sql`action IN (${sql.join(ACTIONS.map((a) => sql.lit(a)))})`,
    )
    .execute();

  await db.schema
    .createIndex("idx_task_board_activity_item")
    .on("task_board_activity")
    .columns(["task_board_item_id", "occurred_at"])
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropIndex("idx_task_board_activity_item").execute();
  await db.schema.dropTable("task_board_activity").execute();
}
