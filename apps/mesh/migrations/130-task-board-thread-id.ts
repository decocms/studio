import { sql, type Kysely } from "kysely";

/**
 * Links task board items to agent threads as MANY-TO-MANY.
 *
 * A task delegated to the Super Agent spawns a run thread; today that's one
 * thread per task, but a task will grow to span multiple threads (re-runs,
 * sub-tasks, follow-ups), so the link lives in its own table rather than a
 * `thread_id` column. Lets the board render a task's thread(s) in the card and
 * derive its live run state (e.g. blocked on user_ask).
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable("task_board_item_threads")
    .addColumn("task_board_item_id", "text", (col) => col.notNull())
    .addColumn("thread_id", "text", (col) => col.notNull())
    .addColumn("organization_id", "text", (col) => col.notNull())
    .addColumn("created_at", "timestamptz", (col) =>
      col.notNull().defaultTo(sql`now()`),
    )
    .addPrimaryKeyConstraint("task_board_item_threads_pkey", [
      "task_board_item_id",
      "thread_id",
    ])
    .execute();

  // Board list attaches threads per item, scoped to the org.
  await db.schema
    .createIndex("task_board_item_threads_item_idx")
    .on("task_board_item_threads")
    .columns(["organization_id", "task_board_item_id"])
    .execute();

  // Reverse lookup: given a run thread, find its task(s).
  await db.schema
    .createIndex("task_board_item_threads_thread_idx")
    .on("task_board_item_threads")
    .column("thread_id")
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable("task_board_item_threads").execute();
}
