import { type Kysely, sql } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`alter table organization_settings rename column kanban_enabled to task_board_enabled`.execute(
    db,
  );
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`alter table organization_settings rename column task_board_enabled to kanban_enabled`.execute(
    db,
  );
}
