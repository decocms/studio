import type { Kysely } from "kysely";

/**
 * Free-text instructions the org appends to the system prompt of every agent
 * run dispatched from a task board card — house rules ("use pnpm", "never
 * touch the generated client") that apply to the work, not to one card.
 *
 * Its own column rather than a `flags` key: the flags bag is boolean toggles
 * only.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .alterTable("organization_settings")
    .addColumn("task_system_prompt", "text")
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .alterTable("organization_settings")
    .dropColumn("task_system_prompt")
    .execute();
}
