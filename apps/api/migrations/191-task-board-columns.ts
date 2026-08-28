import { type Kysely, sql } from "kysely";

/**
 * The columns of a board Studio does not own.
 *
 * Empty for every org that runs the board Studio ships with — those columns
 * are a constant, and rows for them would be identical data that can drift out
 * of agreement with the code defining them. Rows exist only once a board is
 * mirrored from somewhere else, which is what `dynamic_board_columns` says.
 *
 * `key` is what a card's `status` holds, the same as it is for the canonical
 * set. `role` is what automation keys on, and is null for most columns here:
 * a column someone else named means nothing to us until someone says it does.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable("task_board_columns")
    .ifNotExists()
    .addColumn("id", "text", (col) => col.primaryKey())
    .addColumn("organization_id", "text", (col) => col.notNull())
    .addColumn("key", "text", (col) => col.notNull())
    .addColumn("title", "text", (col) => col.notNull())
    .addColumn("position", "integer", (col) => col.notNull())
    .addColumn("role", "text")
    .addColumn("created_at", "timestamptz", (col) =>
      col.notNull().defaultTo(sql`now()`),
    )
    .addColumn("updated_at", "timestamptz", (col) =>
      col.notNull().defaultTo(sql`now()`),
    )
    .execute();

  await db.schema
    .createIndex("task_board_columns_org_key_uniq")
    .ifNotExists()
    .on("task_board_columns")
    .columns(["organization_id", "key"])
    .unique()
    .execute();

  await db.schema
    .createIndex("task_board_columns_org_position_idx")
    .ifNotExists()
    .on("task_board_columns")
    .columns(["organization_id", "position"])
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable("task_board_columns").ifExists().execute();
}
