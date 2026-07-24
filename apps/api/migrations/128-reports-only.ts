import type { Kysely } from "kysely";

/**
 * Org-level flag that collapses the product surface down to the reports
 * panel, hiding the rest of Studio (agents sidebar, settings, files,
 * store, …). It's the first step of a staged simplification: commerce-onboarded
 * orgs start focused on the diagnostic, and other parts get added back later.
 *
 * Nullable on purpose (no default): NULL means "never set" (treated as off),
 * which lets COMMERCE_DISCOVERY_SETUP default it on for commerce orgs while
 * leaving every other org off, and lets an explicit `false` (turned off later)
 * survive a re-run of setup.
 *
 * UI-cosmetic only: nothing server-side enforces it — routes and tools stay
 * reachable. Do not treat as an access-control boundary.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .alterTable("organization_settings")
    .addColumn("reports_only", "boolean")
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .alterTable("organization_settings")
    .dropColumn("reports_only")
    .execute();
}
