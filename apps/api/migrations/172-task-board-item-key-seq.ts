import { sql, type Kysely } from "kysely";

/**
 * Per-org sequential number behind a card's human key (`DECO-01`).
 *
 * A card had no name a person could say out loud: the only identity was the
 * `board_<nanoid>` primary key, and the dialog showed a lossy 6-char slice of
 * it that nothing could look up. The number is scoped to the organization and
 * assigned once at create; the prefix is derived from the org's (immutable)
 * slug at render time, so nothing here has to change when a name does.
 *
 * The unique index is the allocator's correctness: two concurrent creates that
 * read the same `max(key_seq)` race, and the loser fails the insert and retries
 * instead of minting a duplicate key.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .alterTable("task_board_items")
    .addColumn("key_seq", "integer")
    .execute();

  // Backfill oldest-first, so the numbers read as the order the board grew in.
  await sql`
    update task_board_items as t
    set key_seq = numbered.seq
    from (
      select
        id,
        row_number() over (
          partition by organization_id
          order by created_at, id
        ) as seq
      from task_board_items
    ) as numbered
    where t.id = numbered.id
  `.execute(db);

  await db.schema
    .createIndex("task_board_items_org_key_seq_unique")
    .on("task_board_items")
    .columns(["organization_id", "key_seq"])
    .unique()
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .dropIndex("task_board_items_org_key_seq_unique")
    .on("task_board_items")
    .execute();
  await db.schema
    .alterTable("task_board_items")
    .dropColumn("key_seq")
    .execute();
}
