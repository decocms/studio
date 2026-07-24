import { type Kysely, sql } from "kysely";

/**
 * Task activity log — the "changes of the card" timeline (created, status
 * moved, (re)assigned, sprint changed), rendered inline in the task's Activity
 * feed alongside comments, agent sessions and PRs. Append-only; one row per
 * event, with the actor and a jsonb `data` payload ({from,to,...}).
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable("task_board_activity")
    .addColumn("id", "text", (col) => col.primaryKey())
    .addColumn("organization_id", "text", (col) =>
      col.notNull().references("organization.id").onDelete("cascade"),
    )
    .addColumn("task_board_item_id", "text", (col) =>
      col.notNull().references("task_board_items.id").onDelete("cascade"),
    )
    .addColumn("kind", "text", (col) => col.notNull())
    /** User id, or a sentinel ("system"/"super-agent") for machine actors. */
    .addColumn("actor_id", "text")
    .addColumn("data", "jsonb")
    .addColumn("created_at", "timestamptz", (col) =>
      col.notNull().defaultTo(sql`now()`),
    )
    .execute();

  await db.schema
    .createIndex("idx_task_board_activity_item")
    .on("task_board_activity")
    .columns(["organization_id", "task_board_item_id", "created_at"])
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropIndex("idx_task_board_activity_item").execute();
  await db.schema.dropTable("task_board_activity").execute();
}
