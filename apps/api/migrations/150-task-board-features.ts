import { type Kysely, sql } from "kysely";

/**
 * Task board feature expansion — everything a team needs to run work on the
 * Studio board instead of an external tracker (Jira parity for the
 * ai-services-panel use case):
 *
 * - `organization_settings.task_board` (jsonb) — per-org board config:
 *   custom columns (each mapped to a canonical stage + optional per-column
 *   agent automation), and the sprint/release feature toggles. Null = the
 *   default simple board (the 5 built-in columns, sprints/releases off).
 * - `task_board_items` grows `column_id` (custom-column placement — null means
 *   "derive from status"), `tags` (free-form labels), `sprint_id`,
 *   `release_id`, and `automation_column_id` (the column whose automation last
 *   ran, the re-trigger guard).
 * - `task_board_comments` — comment stream per task, one level of replies via
 *   `parent_id`.
 * - `task_board_attachments` — files/images on a task or a comment; bytes live
 *   in the row (capped at the tool layer), served by an org-scoped route.
 * - `task_board_sprints` / `task_board_releases` — the optional planning
 *   entities behind the settings toggles.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .alterTable("organization_settings")
    .addColumn("task_board", "jsonb")
    .execute();

  await db.schema
    .alterTable("task_board_items")
    .addColumn("column_id", "text")
    .addColumn("tags", "jsonb")
    .addColumn("sprint_id", "text")
    .addColumn("release_id", "text")
    .addColumn("automation_column_id", "text")
    .execute();

  await db.schema
    .createTable("task_board_comments")
    .addColumn("id", "text", (col) => col.primaryKey())
    .addColumn("organization_id", "text", (col) =>
      col.notNull().references("organization.id").onDelete("cascade"),
    )
    .addColumn("task_board_item_id", "text", (col) =>
      col.notNull().references("task_board_items.id").onDelete("cascade"),
    )
    .addColumn("parent_id", "text", (col) =>
      col.references("task_board_comments.id").onDelete("cascade"),
    )
    .addColumn("body", "text", (col) => col.notNull())
    .addColumn("created_by", "text", (col) => col.notNull())
    .addColumn("created_at", "timestamptz", (col) =>
      col.notNull().defaultTo(sql`now()`),
    )
    .addColumn("updated_at", "timestamptz", (col) =>
      col.notNull().defaultTo(sql`now()`),
    )
    .execute();

  await db.schema
    .createIndex("idx_task_board_comments_item")
    .on("task_board_comments")
    .columns(["organization_id", "task_board_item_id"])
    .execute();

  await db.schema
    .createTable("task_board_attachments")
    .addColumn("id", "text", (col) => col.primaryKey())
    .addColumn("organization_id", "text", (col) =>
      col.notNull().references("organization.id").onDelete("cascade"),
    )
    .addColumn("task_board_item_id", "text", (col) =>
      col.notNull().references("task_board_items.id").onDelete("cascade"),
    )
    .addColumn("comment_id", "text", (col) =>
      col.references("task_board_comments.id").onDelete("cascade"),
    )
    .addColumn("filename", "text", (col) => col.notNull())
    .addColumn("mime_type", "text", (col) => col.notNull())
    .addColumn("size", "integer", (col) => col.notNull())
    .addColumn("data", "bytea", (col) => col.notNull())
    .addColumn("created_by", "text", (col) => col.notNull())
    .addColumn("created_at", "timestamptz", (col) =>
      col.notNull().defaultTo(sql`now()`),
    )
    .execute();

  await db.schema
    .createIndex("idx_task_board_attachments_item")
    .on("task_board_attachments")
    .columns(["organization_id", "task_board_item_id"])
    .execute();

  await db.schema
    .createTable("task_board_sprints")
    .addColumn("id", "text", (col) => col.primaryKey())
    .addColumn("organization_id", "text", (col) =>
      col.notNull().references("organization.id").onDelete("cascade"),
    )
    .addColumn("name", "text", (col) => col.notNull())
    .addColumn("state", "text", (col) => col.notNull().defaultTo("planned"))
    .addColumn("start_date", "timestamptz")
    .addColumn("end_date", "timestamptz")
    .addColumn("created_by", "text", (col) => col.notNull())
    .addColumn("created_at", "timestamptz", (col) =>
      col.notNull().defaultTo(sql`now()`),
    )
    .addColumn("updated_at", "timestamptz", (col) =>
      col.notNull().defaultTo(sql`now()`),
    )
    .execute();

  await db.schema
    .createTable("task_board_releases")
    .addColumn("id", "text", (col) => col.primaryKey())
    .addColumn("organization_id", "text", (col) =>
      col.notNull().references("organization.id").onDelete("cascade"),
    )
    .addColumn("title", "text", (col) => col.notNull())
    .addColumn("notes", "text")
    .addColumn("created_by", "text", (col) => col.notNull())
    .addColumn("created_at", "timestamptz", (col) =>
      col.notNull().defaultTo(sql`now()`),
    )
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable("task_board_releases").execute();
  await db.schema.dropTable("task_board_sprints").execute();
  await db.schema.dropIndex("idx_task_board_attachments_item").execute();
  await db.schema.dropTable("task_board_attachments").execute();
  await db.schema.dropIndex("idx_task_board_comments_item").execute();
  await db.schema.dropTable("task_board_comments").execute();
  await db.schema
    .alterTable("task_board_items")
    .dropColumn("column_id")
    .dropColumn("tags")
    .dropColumn("sprint_id")
    .dropColumn("release_id")
    .dropColumn("automation_column_id")
    .execute();
  await db.schema
    .alterTable("organization_settings")
    .dropColumn("task_board")
    .execute();
}
