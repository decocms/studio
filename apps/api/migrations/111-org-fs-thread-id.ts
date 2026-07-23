import type { Kysely } from "kysely";

/**
 * Thread provenance for org-fs entries. The `home` volume is org-wide and
 * shared across every chat and member, but a generated deck/page belongs to
 * the chat that produced it. Stamping the writing thread lets the live-preview
 * watcher scope emissions to the originating chat instead of surfacing every
 * org-wide change (which leaked other chats'/members' files into a preview).
 *
 * Nullable: writes not tied to a dispatch (mount write-backs of bash/slides
 * output, backfill) leave it null, and the watcher falls back to same-user
 * scoping for those.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .alterTable("org_fs_entry")
    .addColumn("thread_id", "text")
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.alterTable("org_fs_entry").dropColumn("thread_id").execute();
}
