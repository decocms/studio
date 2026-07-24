import { type Kysely, sql } from "kysely";

/**
 * Per-org sequential task number (`seq`) — a short, human-friendly key shown on
 * cards and the task modal (e.g. "#42"), the way trackers surface PROJ-123.
 * Assigned as max(seq)+1 per org at create time. Backfilled here by created_at
 * order so existing tasks get stable numbers.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .alterTable("task_board_items")
    .addColumn("seq", "integer")
    .execute();

  // Number existing rows per org, oldest first (id breaks created_at ties).
  await sql`
    UPDATE task_board_items AS t
    SET seq = s.rn
    FROM (
      SELECT id,
             row_number() OVER (
               PARTITION BY organization_id
               ORDER BY created_at ASC, id ASC
             ) AS rn
      FROM task_board_items
    ) AS s
    WHERE t.id = s.id
  `.execute(db);

  await db.schema
    .createIndex("idx_task_board_items_org_seq")
    .on("task_board_items")
    .columns(["organization_id", "seq"])
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropIndex("idx_task_board_items_org_seq").execute();
  await db.schema.alterTable("task_board_items").dropColumn("seq").execute();
}
