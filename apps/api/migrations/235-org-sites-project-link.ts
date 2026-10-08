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
 * - `linked_at`: set when the slug is first used and never cleared. A used
 *   slug is never released or moved to another org; after its project is
 *   deleted, only the same org may link it to another of its projects. Every
 *   row that exists when this runs is treated as used (`linked_at =
 *   created_at` when no project is found): each came from a deco.cx import or
 *   backfill, so it is a real public site that may already have site tokens
 *   out.
 * - `organization_id` becomes nullable with `ON DELETE SET NULL` (was
 *   `CASCADE`). Deleting an org leaves its slugs behind as tombstones — rows
 *   with no org that no one can claim — instead of freeing them for reuse.
 *
 * Backfill: each slug is linked to the single project in its org whose
 * `metadata.siteSlug` is exactly the slug. Nothing else is a match — not the
 * project title, not a case- or whitespace-variant. If no project or more than
 * one matches, the row stays unlinked and is counted; nothing is guessed.
 * Project rows are only read, never written.
 *
 * Locking: Kysely runs pending migrations in one transaction, so every lock
 * taken here is held until commit while old pods keep serving. The plan is
 * read first (ACCESS SHARE only); the ALTERs then take short exclusive locks
 * on `org_sites` and SHARE ROW EXCLUSIVE on `connections` / `organization`
 * (the FKs), and the plan is applied in a few set-based UPDATEs. A
 * `lock_timeout` makes a blocked ALTER fail fast — the deploy retries —
 * instead of queueing every writer behind it.
 *
 * See unlinked rows:
 *   SELECT slug, organization_id, source FROM org_sites
 *   WHERE project_id IS NULL AND organization_id IS NOT NULL;
 */

const MIGRATION_ACTOR = "migration-235";
/** Rows per set-based UPDATE when applying the plan. */
const APPLY_BATCH = 1000;

export interface OrgSiteBackfillPlan {
  links: { slug: string; projectId: string }[];
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
 * Decide, from reads only, which project each `org_sites` row links to: the
 * single project in its org whose `metadata.siteSlug` is exactly the slug. Exported for the test.
 */
export async function planOrgSiteProjectLinks(
  db: Kysely<unknown>,
): Promise<OrgSiteBackfillPlan> {
  const plan: OrgSiteBackfillPlan = {
    links: [],
    none: 0,
    ambiguous: [],
    unparseableMetadata: 0,
  };

  const sites = await sql<{ slug: string; organization_id: string }>`
    SELECT slug, organization_id FROM org_sites
    WHERE organization_id IS NOT NULL
    ORDER BY organization_id, slug
  `.execute(db);
  if (sites.rows.length === 0) return plan;

  const projects = await sql<{
    id: string;
    organization_id: string;
    metadata: string | null;
  }>`
    SELECT id, organization_id, metadata FROM connections
    WHERE connection_type = 'VIRTUAL'
      AND organization_id IN (
        SELECT organization_id FROM org_sites WHERE organization_id IS NOT NULL
      )
    ORDER BY organization_id, id
  `.execute(db);

  // `${org}\0${slug}` → ids of the projects whose `metadata.siteSlug` is it.
  const byMetadata = new Map<string, string[]>();
  for (const project of projects.rows) {
    if (!project.metadata) continue;
    let siteSlug: unknown;
    try {
      const value: unknown = JSON.parse(project.metadata);
      if (value && typeof value === "object") {
        siteSlug = (value as Record<string, unknown>).siteSlug;
      }
    } catch {
      // A malformed row can't name a site.
      plan.unparseableMetadata++;
      continue;
    }
    if (typeof siteSlug !== "string" || !siteSlug) continue;
    const key = `${project.organization_id}\0${siteSlug}`;
    const list = byMetadata.get(key) ?? [];
    list.push(project.id);
    byMetadata.set(key, list);
  }

  for (const { slug, organization_id } of sites.rows) {
    const candidates = byMetadata.get(`${organization_id}\0${slug}`) ?? [];
    if (candidates.length === 0) {
      plan.none++;
    } else if (candidates.length > 1) {
      plan.ambiguous.push({ slug, projectIds: candidates });
    } else {
      plan.links.push({ slug, projectId: candidates[0]! });
    }
  }
  return plan;
}

/**
 * Apply planned links in set-based batches. A project deleted since planning
 * is skipped (the `EXISTS`), not an FK error that aborts the deploy. Returns
 * how many rows were linked.
 */
export async function applyOrgSiteProjectLinks(
  db: Kysely<unknown>,
  links: OrgSiteBackfillPlan["links"],
): Promise<number> {
  let applied = 0;
  for (let i = 0; i < links.length; i += APPLY_BATCH) {
    const values = sql.join(
      links
        .slice(i, i + APPLY_BATCH)
        .map((l) => sql`(${l.slug}::text, ${l.projectId}::text)`),
    );
    const result = await sql`
      UPDATE org_sites o
      SET project_id = v.pid,
          linked_at = now(),
          updated_by = ${MIGRATION_ACTOR},
          updated_at = now()
      FROM (VALUES ${values}) AS v(slug, pid)
      WHERE o.slug = v.slug
        AND o.project_id IS NULL
        AND EXISTS (SELECT 1 FROM connections c WHERE c.id = v.pid)
    `.execute(db);
    applied += Number(result.numAffectedRows ?? 0n);
  }
  return applied;
}

export async function up(db: Kysely<unknown>): Promise<void> {
  // Fail fast instead of queueing every writer behind a blocked ALTER.
  await sql`SET LOCAL lock_timeout = '5s'`.execute(db);

  // 1. Plan with reads only, before taking any lock.
  const plan = await planOrgSiteProjectLinks(db);

  // 2. Schema.
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
        ON DELETE SET NULL NOT VALID
  `.execute(db);
  await sql`
    ALTER TABLE org_sites VALIDATE CONSTRAINT org_sites_organization_id_fkey
  `.execute(db);

  // 3. Apply the plan.
  const linked = await applyOrgSiteProjectLinks(db, plan.links);

  // 4. Every existing slug is a real public site: mark it used, so it is never
  //    released or moved even when no project could be linked.
  const marked = await sql`
    UPDATE org_sites SET linked_at = created_at
    WHERE organization_id IS NOT NULL AND linked_at IS NULL
  `.execute(db);

  await sql`SET LOCAL lock_timeout = DEFAULT`.execute(db);

  console.log(
    `[migration 235] org_sites: linked=${linked} ` +
      `(planned=${plan.links.length}, ` +
      `skipped_deleted_project=${plan.links.length - linked}) ` +
      `none=${plan.none} ambiguous=${plan.ambiguous.length} ` +
      `unlinked_marked_used=${Number(marked.numAffectedRows ?? 0n)} ` +
      `unparseable_project_metadata=${plan.unparseableMetadata}`,
  );
  for (const { slug, projectIds } of plan.ambiguous) {
    console.log(
      `[migration 235] left unlinked, several projects use "${slug}": ${projectIds.join(", ")}`,
    );
  }
}

export async function down(db: Kysely<unknown>): Promise<void> {
  // The old shape can't hold a slug without an org, and dropping a tombstone
  // would make a deleted org's slug claimable again — breaking "never reused"
  // silently. Refuse; an operator who accepts that deletes them explicitly.
  const tombstones = await sql`
    SELECT 1 FROM org_sites WHERE organization_id IS NULL LIMIT 1
  `.execute(db);
  if (tombstones.rows.length > 0) {
    throw new Error(
      "migration 235 down: tombstoned slugs exist (org_sites.organization_id IS NULL); refusing to free them",
    );
  }

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
