import type { Kysely } from "kysely";

/**
 * Password-protected sharing for org-fs entries — a gate layered on top of the
 * link-accessible `read_public` flag (migration 120). See
 * `.context/file-share-password-spec.md`.
 *
 * - `share_password_hash`: scrypt hash of the share password. Null on a
 *   published entry means fully public; set means the `/read` proxy serves an
 *   interstitial password form before the bytes.
 * - `share_secret`: random per-node token mixed into the unlock cookie's
 *   signature. Rotated on every password change so previously-issued unlock
 *   cookies stop validating (password change logs everyone out).
 *
 * Both null by default and meaningless unless `read_public` is true. Like the
 * public flag, they live on files AND dirs (a folder password gates its whole
 * subtree, resolved most-specific-node-wins at read time). Never exposed to
 * clients — the API surfaces only a derived `shareMode`.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .alterTable("org_fs_entry")
    .addColumn("share_password_hash", "text")
    .addColumn("share_secret", "text")
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .alterTable("org_fs_entry")
    .dropColumn("share_password_hash")
    .dropColumn("share_secret")
    .execute();
}
