import { type Kysely, sql } from "kysely";

/** Migration 150's action list, plus the `tags_changed` this migration makes
 *  possible. Its CHECK constraint is replaced wholesale — 150 may already be
 *  live, so editing its list in place wouldn't reach a deployed database. A
 *  frozen snapshot like 150's; `activity-actions.test.ts` reads this one
 *  (the newest) to prove SQL and TypeScript agree. */
export const ACTIONS = [
  "created",
  "status_changed",
  "assignee_changed",
  "priority_changed",
  "due_date_changed",
  "title_changed",
  "description_changed",
  "tags_changed",
] as const;

/**
 * Tags on task board items. Reuses `organization_tags` (previously
 * member-only) as the org-wide tag pool, adding a `color` column (hex, picked
 * by the user) so a tag renders a dot like priority does.
 * `task_board_item_tags` is the many-to-many join; it needs no
 * `organization_id` of its own since both sides are already org-scoped.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .alterTable("organization_tags")
    .addColumn("color", "text")
    .execute();

  await db.schema
    .createTable("task_board_item_tags")
    .addColumn("task_board_item_id", "text", (col) =>
      col.notNull().references("task_board_items.id").onDelete("cascade"),
    )
    .addColumn("id", "text", (col) =>
      col.notNull().references("organization_tags.id").onDelete("cascade"),
    )
    .addColumn("created_by", "text", (col) => col.notNull())
    .addColumn("created_at", "timestamptz", (col) =>
      col.notNull().defaultTo(sql`now()`),
    )
    .addPrimaryKeyConstraint("task_board_item_tags_pkey", [
      "task_board_item_id",
      "id",
    ])
    .execute();

  await db.schema
    .createIndex("idx_task_board_item_tags_tag")
    .on("task_board_item_tags")
    .columns(["id"])
    .execute();

  await replaceActivityActionCheck(db, ACTIONS);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await replaceActivityActionCheck(
    db,
    ACTIONS.filter((a) => a !== "tags_changed"),
  );
  await db.schema.dropIndex("idx_task_board_item_tags_tag").execute();
  await db.schema.dropTable("task_board_item_tags").execute();
  await db.schema.alterTable("organization_tags").dropColumn("color").execute();
}

/** Swap `task_board_activity`'s action CHECK constraint for one allowing
 *  exactly `actions`. */
async function replaceActivityActionCheck(
  db: Kysely<unknown>,
  actions: readonly string[],
): Promise<void> {
  await sql`ALTER TABLE task_board_activity DROP CONSTRAINT chk_task_board_activity_action`.execute(
    db,
  );
  await sql`ALTER TABLE task_board_activity ADD CONSTRAINT chk_task_board_activity_action CHECK (action IN (${sql.join(
    actions.map((a) => sql.lit(a)),
  )}))`.execute(db);
}
