import { type Kysely, sql } from "kysely";

/**
 * `task_board_items` — org-owned task board cards. Independent of chat
 * threads; `assignee_id` references an org member's user id but has no hard
 * FK (member lookups are validated at the tool layer, matching how member
 * references work elsewhere in this codebase).
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable("task_board_items")
    .addColumn("id", "text", (col) => col.primaryKey().notNull())
    .addColumn("organization_id", "text", (col) =>
      col.notNull().references("organization.id").onDelete("cascade"),
    )
    .addColumn("title", "text", (col) => col.notNull())
    .addColumn("description", "text")
    .addColumn("status", "text", (col) => col.notNull().defaultTo("triage"))
    .addColumn("priority", "text", (col) => col.notNull().defaultTo("medium"))
    .addColumn("assignee_id", "text")
    .addColumn("created_by", "text", (col) => col.notNull())
    .addColumn("created_at", "timestamptz", (col) =>
      col.notNull().defaultTo(sql`now()`),
    )
    .addColumn("updated_by", "text", (col) => col.notNull())
    .addColumn("updated_at", "timestamptz", (col) =>
      col.notNull().defaultTo(sql`now()`),
    )
    .execute();

  await db.schema
    .createIndex("idx_task_board_items_org")
    .on("task_board_items")
    .column("organization_id")
    .execute();

  await db.schema
    .alterTable("organization_settings")
    .addColumn("task_board_enabled", "boolean", (col) =>
      col.notNull().defaultTo(sql`false`),
    )
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .alterTable("organization_settings")
    .dropColumn("task_board_enabled")
    .execute();
  await db.schema.dropTable("task_board_items").execute();
}
