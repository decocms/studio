import type { Kysely } from "kysely";

/**
 * Task board graduated out of its opt-in flag — every org has it now, so the
 * gating column is dead weight.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .alterTable("organization_settings")
    .dropColumn("task_board_enabled")
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .alterTable("organization_settings")
    .addColumn("task_board_enabled", "boolean", (col) =>
      col.notNull().defaultTo(false),
    )
    .execute();
}
