import { type Kysely, sql } from "kysely";

/**
 * Make a card's `status` a reference — but only on a board that has columns to
 * reference.
 *
 * `status` is free text holding either one of Studio's lanes or a key from
 * `task_board_columns`, and nothing has been stopping it from holding neither.
 * A card whose status names no column renders nowhere: invisible, not broken,
 * which is the worst way for a bug to arrive.
 *
 * The foreign key is optional by construction. Under MATCH SIMPLE a composite
 * key with any NULL part is not checked, so `board_column_org` NULL means "this
 * status is one of Studio's lanes" and the constraint sleeps. Set, it equals
 * `organization_id` and the constraint holds. That is what lets a board built
 * from constants coexist with one built from rows, without seeding rows for
 * every org just to satisfy a constraint.
 *
 * ON DELETE RESTRICT on purpose. A column removed upstream must not take the
 * customer's cards with it (CASCADE) and cannot blank a NOT NULL status (SET
 * NULL), so the only honest action is to refuse — which forces the sync to
 * rescue those cards before dropping the column, instead of orphaning them
 * quietly. The rescue is application policy; the constraint only makes
 * skipping it impossible.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .alterTable("task_board_items")
    .addColumn("board_column_org", "text")
    .execute();

  // Belt to the FK's braces: without it the two org ids could disagree and the
  // key would be validating a column of some other tenant's board.
  await sql`
    ALTER TABLE task_board_items
      ADD CONSTRAINT chk_task_board_items_column_org
      CHECK (board_column_org IS NULL OR board_column_org = organization_id)
  `.execute(db);

  await sql`
    ALTER TABLE task_board_items
      ADD CONSTRAINT task_board_items_board_column_fkey
      FOREIGN KEY (board_column_org, status)
      REFERENCES task_board_columns (organization_id, key)
      ON DELETE RESTRICT
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`
    ALTER TABLE task_board_items
      DROP CONSTRAINT IF EXISTS task_board_items_board_column_fkey
  `.execute(db);
  await sql`
    ALTER TABLE task_board_items
      DROP CONSTRAINT IF EXISTS chk_task_board_items_column_org
  `.execute(db);
  await db.schema
    .alterTable("task_board_items")
    .dropColumn("board_column_org")
    .execute();
}
