import { Kysely, sql } from "kysely";

/**
 * Renamed to `task_board_enabled` by migration 129 — this migration's
 * content must stay unchanged since it may already be recorded as executed
 * in some environments.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .alterTable("organization_settings")
    .addColumn("kanban_enabled", "boolean", (col) =>
      col.notNull().defaultTo(sql`false`),
    )
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .alterTable("organization_settings")
    .dropColumn("kanban_enabled")
    .execute();
}
