import type { Kysely } from "kysely";

/**
 * Adds `site_slug` to `org_file_configs` for the new `managed` credential type.
 *
 * A `managed` config stores no S3 secret: at upload/list time studio mints
 * prefix-scoped STS credentials for `site_slug` (verified against `org_sites`
 * ownership). `site_slug` is NULL for `static` (BYOB) and legacy `sts-session`
 * rows. `credential_type` is a plain text column (migration 112, no CHECK), so
 * allowing `'managed'` needs no DDL beyond this column — only a TS union widen.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .alterTable("org_file_configs")
    .addColumn("site_slug", "text")
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .alterTable("org_file_configs")
    .dropColumn("site_slug")
    .execute();
}
