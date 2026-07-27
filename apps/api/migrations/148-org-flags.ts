import type { Kysely } from "kysely";

/**
 * One jsonb bag for org-level boolean toggles, replacing the
 * column-per-flag pattern (`reports_only` predates this and stays put).
 *
 * The set of valid flags is defined in ONE place —
 * `@decocms/shared/organization/schema.ts` (`OrgFlagsSchema`) — so adding a
 * flag is a one-line schema change plus its consumer, with no new migration.
 *
 * Updates shallow-merge (`flags || $new`) in the storage adapter, so a
 * partial write never wipes neighboring flags. Nullable on purpose: NULL
 * means "no flag ever set" (every flag reads as off).
 *
 * Flags are UI-cosmetic/product toggles, not access control: nothing here
 * needs a DB index, constraint, or cross-org query — anything that does gets
 * its own column instead.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .alterTable("organization_settings")
    .addColumn("flags", "jsonb")
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .alterTable("organization_settings")
    .dropColumn("flags")
    .execute();
}
