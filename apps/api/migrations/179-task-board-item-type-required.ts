import { type Kysely, sql } from "kysely";

/**
 * Make a card's `type` mandatory, defaulting to `chore`.
 *
 * 176 made it nullable so no existing card would be assigned a shape it never
 * declared. In practice that left a field most cards never carried and a footer
 * whose glyph column appeared and vanished between rows. A required field with
 * a least-committal default reads better than an optional one nobody fills.
 *
 * `chore` is that default because it is the type that claims the least: calling
 * unclassified work maintenance overstates nothing, where `feature` or `bug`
 * would assert something about it. Existing cards are backfilled to it, which
 * IS a guess — an intentional one, and reversible via `down`, which restores
 * nullability but cannot tell a backfilled `chore` from a chosen one.
 */
const TYPES = ["bug", "feature", "chore", "spike", "security"] as const;

const DEFAULT_TYPE = "chore";

export async function up(db: Kysely<unknown>): Promise<void> {
  // Backfill first: SET NOT NULL scans the table and would reject any null.
  await sql`UPDATE task_board_items SET type = ${sql.lit(DEFAULT_TYPE)} WHERE type IS NULL`.execute(
    db,
  );
  await sql`ALTER TABLE task_board_items ALTER COLUMN type SET DEFAULT ${sql.lit(DEFAULT_TYPE)}`.execute(
    db,
  );
  await sql`ALTER TABLE task_board_items ALTER COLUMN type SET NOT NULL`.execute(
    db,
  );
  // 176's CHECK tolerated NULL; the column no longer can.
  await sql`ALTER TABLE task_board_items DROP CONSTRAINT chk_task_board_items_type`.execute(
    db,
  );
  await sql`ALTER TABLE task_board_items ADD CONSTRAINT chk_task_board_items_type CHECK (type IN (${sql.join(
    TYPES.map((t) => sql.lit(t)),
  )}))`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`ALTER TABLE task_board_items DROP CONSTRAINT chk_task_board_items_type`.execute(
    db,
  );
  await sql`ALTER TABLE task_board_items ADD CONSTRAINT chk_task_board_items_type CHECK (type IS NULL OR type IN (${sql.join(
    TYPES.map((t) => sql.lit(t)),
  )}))`.execute(db);
  await sql`ALTER TABLE task_board_items ALTER COLUMN type DROP NOT NULL`.execute(
    db,
  );
  await sql`ALTER TABLE task_board_items ALTER COLUMN type DROP DEFAULT`.execute(
    db,
  );
}
