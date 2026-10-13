import { type Kysely, sql } from "kysely";

/**
 * `connections.url_slug`: the name a project (VIRTUAL row) or connection goes
 * by in Studio URLs, unique per organization.
 *
 * The existing `slug` column can't serve: it is re-derived from
 * app_name/connection_url/title on every update and groups sibling installs
 * of one app, so it is neither stable nor unique.
 *
 * Backfill derives the slug from the title, oldest row first, suffixing
 * `-2`, `-3`… on collision. Rows written by older code while this deploys
 * keep a NULL slug, which the unique index permits and the UI falls back to
 * the id for.
 *
 * `connection_slug_aliases` keeps slugs a row used to have, so links made
 * before a slug edit still resolve. Aliases go with their row.
 *
 * The slug rules are inlined so this migration stays deterministic if
 * `@decocms/shared/url-slug` changes.
 */

const MAX = 64;
const RESERVED = new Set([
  "new",
  "edit",
  "settings",
  "apps",
  "projects",
  "connections",
]);

function slugify(input: string): string {
  return input
    .toLowerCase()
    .trim()
    .replace(/\//g, "-")
    .replace(/[^a-z0-9\s_-]+/g, "")
    .replace(/[\s_-]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function base(title: string | null, fallback: string): string {
  const slug = slugify(title ?? "")
    .slice(0, MAX)
    .replace(/-+$/, "");
  return slug.length >= 2 && !RESERVED.has(slug) ? slug : fallback;
}

function candidate(root: string, attempt: number): string {
  if (attempt <= 1) return root;
  const suffix = `-${attempt}`;
  return `${root.slice(0, MAX - suffix.length).replace(/-+$/, "")}${suffix}`;
}

type Row = {
  id: string;
  organization_id: string;
  title: string | null;
  connection_type: string;
};

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`ALTER TABLE connections ADD COLUMN url_slug text`.execute(db);

  const { rows } = await sql<Row>`
    SELECT id, organization_id, title, connection_type
    FROM connections
    ORDER BY organization_id, created_at, id
  `.execute(db);

  const assigned: Array<{ id: string; slug: string }> = [];
  let org: string | null = null;
  let taken = new Set<string>();
  for (const row of rows) {
    if (row.organization_id !== org) {
      org = row.organization_id;
      taken = new Set();
    }
    const root = base(
      row.title,
      row.connection_type === "VIRTUAL" ? "project" : "app",
    );
    let attempt = 1;
    while (taken.has(candidate(root, attempt))) attempt++;
    const slug = candidate(root, attempt);
    taken.add(slug);
    assigned.push({ id: row.id, slug });
  }

  for (let i = 0; i < assigned.length; i += 1000) {
    const chunk = assigned.slice(i, i + 1000);
    await sql`
      UPDATE connections c
      SET url_slug = v.slug
      FROM unnest(
        ${sql.val(chunk.map((a) => a.id))}::text[],
        ${sql.val(chunk.map((a) => a.slug))}::text[]
      ) AS v(id, slug)
      WHERE c.id = v.id
    `.execute(db);
  }

  await sql`
    CREATE UNIQUE INDEX idx_connections_org_url_slug
      ON connections (organization_id, url_slug)
  `.execute(db);

  await sql`
    CREATE TABLE connection_slug_aliases (
      organization_id text NOT NULL,
      slug text NOT NULL,
      connection_id text NOT NULL REFERENCES connections(id) ON DELETE CASCADE,
      created_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (organization_id, slug)
    )
  `.execute(db);

  await sql`
    CREATE INDEX idx_connection_slug_aliases_connection
      ON connection_slug_aliases (connection_id)
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP TABLE connection_slug_aliases`.execute(db);
  await sql`DROP INDEX idx_connections_org_url_slug`.execute(db);
  await sql`ALTER TABLE connections DROP COLUMN url_slug`.execute(db);
}
