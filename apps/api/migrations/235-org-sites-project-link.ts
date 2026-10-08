import { type Kysely, sql } from "kysely";

/**
 * Migration 235 — link each site slug in `org_sites` to the project that uses it.
 *
 * The site slug is the public id of a site: CDN paths, site tokens, telemetry
 * and asset URLs all carry it. Tokens can't be revoked, so a slug must never
 * change once a project uses it and must never move to another tenant. Until
 * now the project → site link lived only in the project's member-editable
 * `metadata.siteSlug` (or, for older imports, its title). This makes the
 * database the source of truth:
 *
 * - `project_id`: the project (a VIRTUAL row in `connections`) the slug belongs
 *   to. At most one slug per project (partial unique index). `ON DELETE SET
 *   NULL`, so deleting the project keeps the slug reserved for its org.
 * - `linked_at`: set the first time the slug is linked and never cleared. It
 *   tells "never used" apart from "used, project since deleted": only the
 *   former may be released or moved to another org.
 * - `organization_id` becomes nullable with `ON DELETE SET NULL` (was
 *   `CASCADE`). Deleting an org leaves its slugs behind as tombstones — rows
 *   with no org that no one can claim — instead of freeing them for reuse.
 *
 * Backfill: each slug is linked to the single project in its org that resolves
 * to it, using the same rule as `resolveAgentSiteSlug`: first `metadata.siteSlug`;
 * only when no project has it there, a project with no `metadata.siteSlug`
 * whose title is the slug (pre-`siteSlug` imports). If no project or more than
 * one matches, the row stays unlinked and is counted; nothing is guessed.
 * Project rows are only read, never written.
 *
 * See unlinked rows:
 *   SELECT slug, organization_id, source FROM org_sites
 *   WHERE project_id IS NULL AND organization_id IS NOT NULL;
 */

const MIGRATION_ACTOR = "migration-235";

/** Mirrors `resolveAgentSiteSlug` — frozen here so the migration never drifts. */
function normalize(value: unknown): string {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

export interface OrgSiteBackfillResult {
  linkedByMetadata: number;
  linkedByTitle: number;
  none: number;
  ambiguous: { slug: string; projectIds: string[] }[];
  unparseableMetadata: number;
}

async function findOrgFkName(db: Kysely<unknown>): Promise<string | null> {
  const result = await sql<{ conname: string }>`
    SELECT conname FROM pg_constraint
    WHERE conrelid = 'org_sites'::regclass
      AND confrelid = 'organization'::regclass
      AND contype = 'f'
  `.execute(db);
  return result.rows[0]?.conname ?? null;
}

/**
 * Link every unlinked `org_sites` row whose org has exactly one project
 * resolving to its slug. Exported for the migration test.
 */
export async function backfillOrgSiteProjectLinks(
  db: Kysely<unknown>,
): Promise<OrgSiteBackfillResult> {
  const result: OrgSiteBackfillResult = {
    linkedByMetadata: 0,
    linkedByTitle: 0,
    none: 0,
    ambiguous: [],
    unparseableMetadata: 0,
  };

  const sites = await sql<{ slug: string; organization_id: string }>`
    SELECT slug, organization_id FROM org_sites
    WHERE project_id IS NULL AND organization_id IS NOT NULL
    ORDER BY organization_id, slug
  `.execute(db);

  const slugsByOrg = new Map<string, string[]>();
  for (const row of sites.rows) {
    const list = slugsByOrg.get(row.organization_id) ?? [];
    list.push(row.slug);
    slugsByOrg.set(row.organization_id, list);
  }

  for (const [organizationId, slugs] of slugsByOrg) {
    const projects = await sql<{
      id: string;
      title: string | null;
      metadata: string | null;
    }>`
      SELECT id, title, metadata FROM connections
      WHERE organization_id = ${organizationId}
        AND connection_type = 'VIRTUAL'
      ORDER BY id
    `.execute(db);

    // Projects by the slug they resolve to, split by where it comes from.
    const byMetadata = new Map<string, string[]>();
    const byTitle = new Map<string, string[]>();
    for (const project of projects.rows) {
      let stored = "";
      if (project.metadata) {
        try {
          const parsed: unknown = JSON.parse(project.metadata);
          if (parsed && typeof parsed === "object") {
            stored = normalize((parsed as { siteSlug?: unknown }).siteSlug);
          }
        } catch {
          // A malformed row can't name a site; count it and fall back to title.
          result.unparseableMetadata++;
        }
      }
      const target = stored ? byMetadata : byTitle;
      const slug = stored || normalize(project.title);
      if (!slug) continue;
      const list = target.get(slug) ?? [];
      list.push(project.id);
      target.set(slug, list);
    }

    for (const slug of slugs) {
      const metaCandidates = byMetadata.get(slug) ?? [];
      const candidates =
        metaCandidates.length > 0 ? metaCandidates : (byTitle.get(slug) ?? []);
      if (candidates.length === 0) {
        result.none++;
        continue;
      }
      if (candidates.length > 1) {
        result.ambiguous.push({ slug, projectIds: candidates });
        continue;
      }
      await sql`
        UPDATE org_sites
        SET project_id = ${candidates[0]},
            linked_at = now(),
            updated_by = ${MIGRATION_ACTOR},
            updated_at = now()
        WHERE slug = ${slug} AND project_id IS NULL
      `.execute(db);
      if (metaCandidates.length > 0) result.linkedByMetadata++;
      else result.linkedByTitle++;
    }
  }

  return result;
}

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    ALTER TABLE org_sites
      ADD COLUMN project_id text NULL
        REFERENCES connections(id) ON DELETE SET NULL,
      ADD COLUMN linked_at timestamptz NULL
  `.execute(db);
  await sql`
    CREATE UNIQUE INDEX org_sites_project_id_uq
      ON org_sites (project_id) WHERE project_id IS NOT NULL
  `.execute(db);

  // Deleting an org must not free its slugs: CASCADE → SET NULL (tombstone).
  const fk = await findOrgFkName(db);
  if (fk) {
    await sql`ALTER TABLE org_sites DROP CONSTRAINT ${sql.id(fk)}`.execute(db);
  }
  await sql`
    ALTER TABLE org_sites ALTER COLUMN organization_id DROP NOT NULL
  `.execute(db);
  await sql`
    ALTER TABLE org_sites
      ADD CONSTRAINT org_sites_organization_id_fkey
        FOREIGN KEY (organization_id) REFERENCES organization(id)
        ON DELETE SET NULL
  `.execute(db);

  const result = await backfillOrgSiteProjectLinks(db);
  console.log(
    `[migration 235] org_sites: linked=${result.linkedByMetadata + result.linkedByTitle} ` +
      `(metadata=${result.linkedByMetadata}, title=${result.linkedByTitle}) ` +
      `none=${result.none} ambiguous=${result.ambiguous.length} ` +
      `unparseable_project_metadata=${result.unparseableMetadata}`,
  );
  for (const { slug, projectIds } of result.ambiguous) {
    console.log(
      `[migration 235] left unlinked, several projects use "${slug}": ${projectIds.join(", ")}`,
    );
  }
}

export async function down(db: Kysely<unknown>): Promise<void> {
  // The old shape can't hold a slug without an org: tombstones are dropped
  // (the slug becomes claimable again under the previous release).
  await sql`DELETE FROM org_sites WHERE organization_id IS NULL`.execute(db);

  const fk = await findOrgFkName(db);
  if (fk) {
    await sql`ALTER TABLE org_sites DROP CONSTRAINT ${sql.id(fk)}`.execute(db);
  }
  await sql`
    ALTER TABLE org_sites ALTER COLUMN organization_id SET NOT NULL
  `.execute(db);
  await sql`
    ALTER TABLE org_sites
      ADD CONSTRAINT org_sites_organization_id_fkey
        FOREIGN KEY (organization_id) REFERENCES organization(id)
        ON DELETE CASCADE
  `.execute(db);

  await sql`DROP INDEX IF EXISTS org_sites_project_id_uq`.execute(db);
  await sql`
    ALTER TABLE org_sites DROP COLUMN project_id, DROP COLUMN linked_at
  `.execute(db);
}
