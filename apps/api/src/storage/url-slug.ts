import {
  URL_SLUG_MAX,
  UrlSlugSchema,
  urlSlugCandidate,
} from "@decocms/shared/url-slug";
import { type Kysely, sql } from "kysely";
import type { Database } from "./types";

const URL_SLUG_INDEX = "idx_connections_org_url_slug";
// Suffixing truncates `base`, but every candidate up to `-99999999999999`
// still starts with this many of its characters.
const CANDIDATE_PREFIX = URL_SLUG_MAX - 16;

export class UrlSlugTakenError extends Error {
  constructor(slug: string) {
    super(`The URL slug "${slug}" is already in use in this organization`);
    this.name = "UrlSlugTakenError";
  }
}

export function isUrlSlugConflict(error: unknown): boolean {
  return error instanceof Error && error.message.includes(URL_SLUG_INDEX);
}

/**
 * The first free `base`, `base-2`, … in the org. Aliases count as taken so a
 * new row never inherits another row's old links.
 */
async function nextFreeUrlSlug(
  db: Kysely<Database>,
  organizationId: string,
  base: string,
): Promise<string> {
  const prefix = base.slice(0, CANDIDATE_PREFIX);
  const pattern = `${prefix.replace(/[%_\\]/g, "\\$&")}%`;
  const [current, aliases] = await Promise.all([
    db
      .selectFrom("connections")
      .select("url_slug as slug")
      .where("organization_id", "=", organizationId)
      .where("url_slug", "like", pattern)
      .execute(),
    db
      .selectFrom("connection_slug_aliases")
      .select("slug")
      .where("organization_id", "=", organizationId)
      .where("slug", "like", pattern)
      .execute(),
  ]);
  const taken = new Set([...current, ...aliases].map((r) => r.slug));
  let attempt = 1;
  while (taken.has(urlSlugCandidate(base, attempt))) attempt++;
  return urlSlugCandidate(base, attempt);
}

/**
 * Run `insert` with a free slug derived from `base`, retrying when a
 * concurrent insert claims the same slug first. Each conflict means another
 * row took that slug, so the next attempt picks a later one; getting the
 * same slug back means no progress and fails.
 */
export async function withAllocatedUrlSlug<T>(
  db: Kysely<Database>,
  organizationId: string,
  base: string,
  insert: (urlSlug: string) => Promise<T>,
): Promise<T> {
  let conflicted: string | undefined;
  for (;;) {
    const urlSlug = await nextFreeUrlSlug(db, organizationId, base);
    if (urlSlug === conflicted) {
      throw new UrlSlugTakenError(urlSlug);
    }
    try {
      return await insert(urlSlug);
    } catch (error) {
      if (!isUrlSlugConflict(error)) throw error;
      conflicted = urlSlug;
    }
  }
}

/**
 * Give a row a new slug, keeping the old one as an alias. Claiming a slug
 * that is some row's alias takes it over; claiming another row's current
 * slug fails with `UrlSlugTakenError`.
 */
export async function changeUrlSlug(
  db: Kysely<Database>,
  connectionId: string,
  requested: string,
): Promise<void> {
  // Storage is the trust boundary: entity schemas type url_slug loosely.
  const slug = UrlSlugSchema.parse(requested);
  try {
    await db.transaction().execute(async (trx) => {
      const row = await trx
        .selectFrom("connections")
        .select(["organization_id", "url_slug"])
        .where("id", "=", connectionId)
        .forUpdate()
        .executeTakeFirst();
      if (!row) throw new Error("Connection not found");
      if (row.url_slug === slug) return;
      const organizationId = row.organization_id;

      await trx
        .deleteFrom("connection_slug_aliases")
        .where("organization_id", "=", organizationId)
        .where("slug", "=", slug)
        .execute();
      await trx
        .updateTable("connections")
        .set({ url_slug: slug })
        .where("id", "=", connectionId)
        .execute();
      if (row.url_slug) {
        await trx
          .insertInto("connection_slug_aliases")
          .values({
            organization_id: organizationId,
            slug: row.url_slug,
            connection_id: connectionId,
          })
          .onConflict((oc) =>
            oc
              .columns(["organization_id", "slug"])
              .doUpdateSet({ connection_id: connectionId }),
          )
          .execute();
      }
    });
  } catch (error) {
    if (isUrlSlugConflict(error)) throw new UrlSlugTakenError(slug);
    throw error;
  }
}

/**
 * The id of the org's row a slug names — its current slug first, then an
 * old one. `canonicalSlug` is what the URL should show instead.
 */
export async function resolveUrlSlug(
  db: Kysely<Database>,
  organizationId: string,
  slug: string,
  kind: "project" | "connection",
): Promise<{ id: string; canonicalSlug: string } | null> {
  const typeFilter =
    kind === "project"
      ? sql<boolean>`c.connection_type = 'VIRTUAL'`
      : sql<boolean>`c.connection_type <> 'VIRTUAL'`;
  const { rows } = await sql<{ id: string; url_slug: string }>`
    SELECT c.id, c.url_slug FROM connections c
    WHERE c.organization_id = ${organizationId}
      AND c.url_slug = ${slug} AND ${typeFilter}
    UNION ALL
    SELECT c.id, c.url_slug FROM connection_slug_aliases a
    JOIN connections c ON c.id = a.connection_id
    WHERE a.organization_id = ${organizationId}
      AND a.slug = ${slug} AND ${typeFilter}
    LIMIT 1
  `.execute(db);
  const row = rows[0];
  return row ? { id: row.id, canonicalSlug: row.url_slug } : null;
}
