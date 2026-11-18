import type { Kysely } from "kysely";

/**
 * Migration 265 — the store goal on the Plan page.
 *
 * One sentence per organization, written by a member, with who wrote it and
 * when (`{ statement, updated_by, updated_at }`). NULL means no goal yet. It
 * lives on the settings row, so it goes away with the organization.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .alterTable("organization_settings")
    .addColumn("plan_objective", "jsonb")
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .alterTable("organization_settings")
    .dropColumn("plan_objective")
    .execute();
}
