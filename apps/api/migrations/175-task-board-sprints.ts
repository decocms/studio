import { type Kysely } from "kysely";

/**
 * Sprints for the task board.
 *
 * Two columns, no sprint table: a sprint is a derived window over the org's
 * cadence (`organization_settings.sprint_config` — `{ enabled, weeks,
 * startDate }`), and a card carries only its 1-based sprint NUMBER. Changing
 * the cadence rewrites no cards and there is no lifecycle (create/close/roll
 * over a sprint row) to keep in sync — but it re-dates every window, closed
 * ones included.
 *
 * `sprint` is nullable — a card with no sprint is in the backlog, which is the
 * state every existing card starts in.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .alterTable("organization_settings")
    .addColumn("sprint_config", "jsonb")
    .execute();

  await db.schema
    .alterTable("task_board_items")
    .addColumn("sprint", "integer")
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.alterTable("task_board_items").dropColumn("sprint").execute();
  await db.schema
    .alterTable("organization_settings")
    .dropColumn("sprint_config")
    .execute();
}
