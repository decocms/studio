/**
 * Repair Connection Slug
 *
 * The `slug` column added in 054 is a denormalization of app_name/connection_url/
 * title, and the UI links to a connection by the slug it derives from those same
 * fields. Rows whose column drifted from that derivation (a stale slug left by an
 * update that cleared app_name, or a NULL from a writer that skipped the column)
 * are unreachable: the connection shows up in the list but its detail page 404s.
 *
 * Recompute the column for every non-VIRTUAL row. VIRTUAL rows are excluded on
 * purpose — they aren't routed by slug, and giving them one would enable links to
 * a page that filters them out.
 *
 * NOTE: slug logic is inlined (same as 054) so the migration stays deterministic
 * regardless of future changes to the shared getConnectionSlug function.
 */

import { type Kysely, sql } from "kysely";

function slugify(input: string): string {
  return input
    .toLowerCase()
    .trim()
    .replace(/\//g, "-")
    .replace(/[^a-z0-9\s_-]+/g, "")
    .replace(/[\s_-]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function computeSlug(row: {
  id: string;
  app_name: string | null;
  connection_url: string | null;
  title: string;
}): string {
  if (row.app_name) return row.app_name;
  if (row.connection_url) {
    try {
      const parsed = new URL(row.connection_url);
      const host = parsed.port
        ? `${parsed.hostname}-${parsed.port}`
        : parsed.hostname;
      const raw = (host + parsed.pathname).replace(/\/+$/, "");
      return slugify(raw);
    } catch {
      return slugify(row.connection_url);
    }
  }
  if (row.title) return slugify(row.title);
  return row.id;
}

export async function up(db: Kysely<unknown>): Promise<void> {
  const rows = (await sql`
    SELECT id, app_name, connection_url, title, slug
    FROM connections
    WHERE connection_type != 'VIRTUAL'
  `.execute(db)) as {
    rows: Array<{
      id: string;
      app_name: string | null;
      connection_url: string | null;
      title: string;
      slug: string | null;
    }>;
  };

  let repaired = 0;
  for (const row of rows.rows) {
    const slug = computeSlug(row);
    if (slug === row.slug) continue;
    await sql`UPDATE connections SET slug = ${slug} WHERE id = ${row.id}`.execute(
      db,
    );
    repaired++;
  }

  if (repaired > 0) {
    console.log(`[152] repaired ${repaired} drifted connection slug(s)`);
  }
}

export async function down(): Promise<void> {
  // Data repair only — the previous (drifted) values are not worth restoring.
}
