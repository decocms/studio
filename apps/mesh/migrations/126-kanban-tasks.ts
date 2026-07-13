import { type Kysely, sql } from "kysely";

/**
 * `kanban_tasks` — org-owned kanban board cards. Independent of chat threads;
 * `assignee_id` references an org member's user id but has no hard FK (member
 * lookups are validated at the tool layer, matching how member references
 * work elsewhere in this codebase).
 *
 * Renamed to `task_board_items` by migration 128 — this migration's content
 * must stay unchanged since it may already be recorded as executed in some
 * environments.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable("kanban_tasks")
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
    .createIndex("idx_kanban_tasks_org")
    .on("kanban_tasks")
    .column("organization_id")
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable("kanban_tasks").execute();
}
