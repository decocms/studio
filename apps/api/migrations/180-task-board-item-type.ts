import { type Kysely, sql } from "kysely";

/**
 * What KIND of work a card is: bug, feature, chore, spike, security.
 *
 * Distinct from tags, which carry the AREA a card touches (`SEO`,
 * `Performance`, `Infra` — the reports importer's taxonomy). A card has many
 * areas and exactly one shape, so this is a column with a CHECK rather than
 * another tag.
 *
 * Nullable, with no default: every existing card predates the field and
 * guessing a type for it would be inventing data. An untyped card simply shows
 * no glyph, the same way `priority: "none"` does.
 *
 * `spike` is the one type that changes behaviour rather than just labelling —
 * its deliverable is a writeup, not a diff — so it is worth a column even in a
 * set this small.
 */
const TYPES = ["bug", "feature", "chore", "spike", "security"] as const;

/** Migration 169's action list, plus `type_changed`. Frozen snapshot: the
 *  constraint is replaced wholesale because 169 may already be live, so
 *  editing its list in place wouldn't reach a deployed database.
 *  `activity-actions.test.ts` reads this one (the newest) to prove SQL and
 *  TypeScript agree. */
export const ACTIONS = [
  "created",
  "status_changed",
  "assignee_changed",
  "priority_changed",
  "due_date_changed",
  "title_changed",
  "description_changed",
  "tags_changed",
  "review_requested",
  "review_approved",
  "review_changes_requested",
  "merge_conflict_resolution",
  "merge_failed",
  "type_changed",
] as const;

const NEW_ACTIONS = new Set(["type_changed"]);

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .alterTable("task_board_items")
    .addColumn("type", "text")
    .execute();

  await sql`ALTER TABLE task_board_items ADD CONSTRAINT chk_task_board_items_type CHECK (type IS NULL OR type IN (${sql.join(
    TYPES.map((t) => sql.lit(t)),
  )}))`.execute(db);

  await replaceActivityActionCheck(db, ACTIONS);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await replaceActivityActionCheck(
    db,
    ACTIONS.filter((a) => !NEW_ACTIONS.has(a)),
  );
  await sql`ALTER TABLE task_board_items DROP CONSTRAINT chk_task_board_items_type`.execute(
    db,
  );
  await db.schema.alterTable("task_board_items").dropColumn("type").execute();
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
