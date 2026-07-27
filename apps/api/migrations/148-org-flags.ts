import { sql, type Kysely } from "kysely";

/**
 * One jsonb bag for org-level boolean toggles, replacing the
 * column-per-flag pattern. The set of valid flags is defined in ONE place —
 * `@decocms/shared/organization/schema.ts` (`OrgFlagsSchema`) — so adding a
 * flag is a one-line schema change plus its consumer, with no new migration.
 *
 * Also migrates `reports_only` (migration 128) into the bag: non-NULL values
 * are backfilled as `flags.reports_only` (NULL means "never set" and stays
 * absent — every flag reads as off), then the column is dropped.
 *
 * Updates shallow-merge (`flags || $new`) in the storage adapter, so a
 * partial write never wipes neighboring flags. Nullable on purpose: NULL
 * means "no flag ever set".
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
  await sql`
    UPDATE organization_settings
    SET flags = jsonb_build_object('reports_only', reports_only)
    WHERE reports_only IS NOT NULL
  `.execute(db);
  await db.schema
    .alterTable("organization_settings")
    .dropColumn("reports_only")
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .alterTable("organization_settings")
    .addColumn("reports_only", "boolean")
    .execute();
  await sql`
    UPDATE organization_settings
    SET reports_only = (flags ->> 'reports_only')::boolean
    WHERE flags ? 'reports_only'
  `.execute(db);
  await db.schema
    .alterTable("organization_settings")
    .dropColumn("flags")
    .execute();
}
