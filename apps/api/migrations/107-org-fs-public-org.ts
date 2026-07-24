import { type Kysely, sql } from "kysely";

/**
 * Seeds the system organization that owns the shared public skill-set volumes
 * (`org_fs_entry.organization_id` FKs `organization.id`, so the shared scope
 * must be a real row). No members ever join it — `resolveOrgFromPath` 403s
 * non-members, so it is unreachable as a normal org; only the fs routes'
 * `public-*` volume resolution and the server-side syncer touch it. See
 * `apps/api/src/file-storage/public-sets.ts`.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  // The slug is cosmetic — everything resolves this org by id — but the
  // column is unique and user-claimable, so a deployment where someone
  // already owns "orgfs-public-skills" falls back to a suffixed slug
  // instead of aborting the migration (slugs are immutable, so the owner
  // couldn't self-serve a rename). A bare ON CONFLICT DO NOTHING would be
  // worse: it would silently skip the row and break every org_fs_entry FK
  // write at sync time.
  await sql`
    INSERT INTO "organization" (id, name, slug, "createdAt")
    SELECT
      'org_orgfs_public_skills',
      'Public skill sets (system)',
      CASE
        WHEN EXISTS (
          SELECT 1 FROM "organization" WHERE slug = 'orgfs-public-skills'
        )
        THEN 'orgfs-public-skills-' || substr(md5(random()::text), 1, 8)
        ELSE 'orgfs-public-skills'
      END,
      now()
    ON CONFLICT (id) DO NOTHING
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  // Cascades org_fs_entry rows for the shared volumes (FK ON DELETE CASCADE).
  await sql`
    DELETE FROM "organization" WHERE id = 'org_orgfs_public_skills'
  `.execute(db);
}
