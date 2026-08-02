import { type Kysely, sql } from "kysely";

/**
 * Comments on a task board item — the threads the task dialog's activity feed
 * renders. One level of replies only (`parent_id` points at a thread root and a
 * root always has `parent_id IS NULL`); that shape is enforced by the storage
 * layer, since SQL can't express "my parent has no parent" without a trigger.
 *
 * A null `author_id` means the Super Agent wrote it — same convention as
 * `task_board_activity.actor_id` (it has no member row), and it doubles as the
 * "account deleted" state via the FK's `on delete set null`.
 *
 * `mentions` is the client-resolved list of `@` targets in the body
 * (`[{ kind: "user" | "task", id }]`). It's stored rather than parsed out of
 * the prose because a mention renders as a display label, and labels collide.
 *
 * `agent_thread_id` is set on a comment that mentioned the Super Agent: it's
 * the run's thread, and the thread-finish hook posts the run's answer back as a
 * reply under this comment's thread. No `organization_id` — the task it hangs
 * off is already org-scoped and reads join through it.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable("task_board_comments")
    .addColumn("id", "text", (col) => col.primaryKey())
    .addColumn("task_board_item_id", "text", (col) =>
      col.notNull().references("task_board_items.id").onDelete("cascade"),
    )
    .addColumn("parent_id", "text", (col) =>
      col.references("task_board_comments.id").onDelete("cascade"),
    )
    .addColumn("author_id", "text", (col) =>
      col.references("user.id").onDelete("set null"),
    )
    .addColumn("body", "text", (col) => col.notNull())
    .addColumn("mentions", "jsonb", (col) => col.notNull().defaultTo(sql`'[]'`))
    .addColumn("resolved", "boolean", (col) => col.notNull().defaultTo(false))
    .addColumn("agent_thread_id", "text")
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
    .columns(["task_board_item_id", "created_at"])
    .execute();

  await db.schema
    .createIndex("idx_task_board_comments_parent")
    .on("task_board_comments")
    .column("parent_id")
    .execute();

  // The thread-finish hook looks a comment up by the run thread it started.
  await sql`CREATE INDEX idx_task_board_comments_agent_thread ON task_board_comments (agent_thread_id) WHERE agent_thread_id IS NOT NULL`.execute(
    db,
  );
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropIndex("idx_task_board_comments_agent_thread").execute();
  await db.schema.dropIndex("idx_task_board_comments_parent").execute();
  await db.schema.dropIndex("idx_task_board_comments_item").execute();
  await db.schema.dropTable("task_board_comments").execute();
}
