/**
 * Connection Slug Migration
 *
 * Adds a `slug` column to connections for efficient SQL-level filtering.
 * The slug is derived from app_name, connection_url, or title (in that order).
 * Backfills existing connections using the same logic as getConnectionSlug.
 *
 * NOTE: slug logic is inlined here so the migration stays deterministic
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
  await db.schema.alterTable("connections").addColumn("slug", "text").execute();

  // Backfill slugs for existing connections
  const rows = (await sql`
    SELECT id, app_name, connection_url, title FROM connections
  `.execute(db)) as {
    rows: Array<{
      id: string;
      app_name: string | null;
      connection_url: string | null;
      title: string;
    }>;
  };

  for (const row of rows.rows) {
    const slug = computeSlug(row);
    await sql`UPDATE connections SET slug = ${slug} WHERE id = ${row.id}`.execute(
      db,
    );
  }

  // Add index for slug lookups (filtered by org)
  await db.schema
    .createIndex("idx_connections_org_slug")
    .on("connections")
    .columns(["organization_id", "slug"])
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropIndex("idx_connections_org_slug").execute();
  await db.schema.alterTable("connections").dropColumn("slug").execute();
}
