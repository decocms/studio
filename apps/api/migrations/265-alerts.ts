import { type Kysely, sql } from "kysely";

/**
 * Alerts: something a detector saw that waits for a person or an agent to
 * acknowledge it. One open alert per (org, source, subject, rule); a crossing
 * while one is open adds nothing, and the next one after the ack opens anew.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable("alerts")
    .addColumn("id", "text", (col) => col.primaryKey())
    .addColumn("organization_id", "text", (col) =>
      col.notNull().references("organization.id").onDelete("cascade"),
    )
    // What raised it (`order_monitor`), what it is about (the store's
    // connection id; '' for none) and which of the source's rules fired.
    .addColumn("source", "text", (col) => col.notNull())
    .addColumn("subject_id", "text", (col) => col.notNull().defaultTo(""))
    .addColumn("rule", "text", (col) => col.notNull())
    .addColumn("title", "text", (col) => col.notNull())
    .addColumn("body", "text", (col) => col.notNull().defaultTo(""))
    .addColumn("link", "text")
    .addColumn("created_at", "timestamptz", (col) =>
      col.notNull().defaultTo(sql`now()`),
    )
    .addColumn("acked_at", "timestamptz")
    .addColumn("acked_by", "text")
    .addColumn("ack_note", "text")
    // The task opened for it, if any. Deleting the task keeps the alert.
    .addColumn("task_board_item_id", "text", (col) =>
      col.references("task_board_items.id").onDelete("set null"),
    )
    .execute();

  await db.schema
    .createIndex("alerts_one_open")
    .on("alerts")
    .columns(["organization_id", "source", "subject_id", "rule"])
    .unique()
    .where(sql.ref("acked_at"), "is", null)
    .execute();

  await db.schema
    .createIndex("alerts_org_created")
    .on("alerts")
    .columns(["organization_id", "created_at desc"])
    .execute();

  await db.schema
    .createIndex("alerts_task")
    .on("alerts")
    .column("task_board_item_id")
    .where("task_board_item_id", "is not", null)
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable("alerts").ifExists().execute();
}
