import type { Kysely } from "kysely";

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
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable("order_monitor_state").ifExists().execute();
}
