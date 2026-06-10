import { type Kysely, sql } from "kysely";

/**
 * Seeds the system organization that owns the shared public skill-set volumes
 * (`org_fs_entry.organization_id` FKs `organization.id`, so the shared scope
 * must be a real row). No members ever join it — `resolveOrgFromPath` 403s
 * non-members, so it is unreachable as a normal org; only the fs routes'
 * `public-*` volume resolution and the server-side syncer touch it. See
 * `apps/mesh/src/file-storage/public-sets.ts`.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    INSERT INTO "organization" (id, name, slug, "createdAt")
    VALUES (
      'org_orgfs_public_skills',
      'Public skill sets (system)',
      'orgfs-public-skills',
      now()
    )
    ON CONFLICT (id) DO NOTHING
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  // Cascades org_fs_entry rows for the shared volumes (FK ON DELETE CASCADE).
  await sql`
    DELETE FROM "organization" WHERE id = 'org_orgfs_public_skills'
  `.execute(db);
}
