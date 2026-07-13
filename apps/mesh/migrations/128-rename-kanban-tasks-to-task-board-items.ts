import { type Kysely, sql } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`alter table kanban_tasks rename to task_board_items`.execute(db);
  await sql`alter index idx_kanban_tasks_org rename to idx_task_board_items_org`.execute(
    db,
  );
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`alter index idx_task_board_items_org rename to idx_kanban_tasks_org`.execute(
    db,
  );
  await sql`alter table task_board_items rename to kanban_tasks`.execute(db);
}
