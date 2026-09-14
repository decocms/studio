import { type Kysely, sql } from "kysely";

/**
 * Seeds the system organization that owns every per-user filesystem
 * (`org_fs_entry.organization_id` FKs `organization.id`, so the scope must be
 * a real row). No members ever join it — `resolveOrgFromPath` 403s non-members,
 * so it is unreachable as a normal org; only the instance-level `/api/_users`
 * routes touch it. Mirrors migration 107 (the public skill-set scope). See
 * `apps/api/src/file-storage/user-fs.ts`.
 *
 * The slug is cosmetic (everything resolves this org by id) but the column is
 * unique and user-claimable, so an existing owner of `user-filesystems` gets a
 * suffixed slug rather than aborting the migration — slugs are immutable, so
 * that owner could not self-serve a rename. `ON CONFLICT DO NOTHING` on the
 * slug would be worse: it skips the row and breaks every FK write at upload.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    INSERT INTO "organization" (id, name, slug, "createdAt")
    SELECT
      'org_user_fs',
      'User filesystems (system)',
      CASE
        WHEN EXISTS (
          SELECT 1 FROM "organization" WHERE slug = 'user-filesystems'
        )
        THEN 'user-filesystems-' || substr(md5(random()::text), 1, 8)
        ELSE 'user-filesystems'
      END,
      now()
    ON CONFLICT (id) DO NOTHING
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  /** Cascades org_fs_entry rows for every user volume (FK ON DELETE CASCADE). */
  await sql`
    DELETE FROM "organization" WHERE id = 'org_user_fs'
  `.execute(db);
}
