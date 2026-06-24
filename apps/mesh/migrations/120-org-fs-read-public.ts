import type { Kysely } from "kysely";

/**
 * Per-file public-read flag for org-fs entries. A file flagged `read_public`
 * is served by the `/fs/:volume/read` proxy to anyone — no auth, no org
 * membership — so a member can share a single file (a deck, an image, a PDF)
 * with the open internet via the same proxy URL the org already uses.
 *
 * Defaults to false (org-only, the prior behavior). Only files are ever
 * published; the flag is meaningless on dirs. Overwriting a file preserves
 * its flag (the putFile upsert leaves it untouched); delete + recreate starts
 * private again.
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
