import type { Kysely } from "kysely";

/**
 * Public-read flag for org-fs entries. An entry flagged `read_public` is
 * served by the `/fs/:volume/read` proxy to anyone — no auth, no org
 * membership — so a member can share something with the open internet via the
 * same proxy URL the org already uses.
 *
 * Set on a FILE (a deck, an image, a PDF) it publishes that file; set on a
 * DIR it publishes the whole subtree — the read path inherits from a published
 * ancestor folder, so a page and its co-located assets go public together.
 *
 * Defaults to false (org-only). An in-place overwrite of a live file preserves
 * its flag (editing a published deck stays published); delete + recreate
 * (reviving a tombstone) starts private again, for both files and dirs.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .alterTable("org_fs_entry")
    .addColumn("read_public", "boolean", (col) =>
      col.notNull().defaultTo(false),
    )
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .alterTable("org_fs_entry")
    .dropColumn("read_public")
    .execute();
}
