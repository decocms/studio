import { type Kysely, sql } from "kysely";

/**
 * The per-org "main agent" feature was removed in #6801 (2026-09-03), which
 * deliberately left `organization_settings.main_agent_id` in place ("nothing
 * reads or writes it") to avoid a mixed-pod deploy 500ing on the column.
 * Every pod has long since drained onto that release — this is the follow-up
 * drop.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`ALTER TABLE organization_settings
    DROP COLUMN IF EXISTS main_agent_id`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .alterTable("organization_settings")
    .addColumn("main_agent_id", "text")
    .execute();
}
