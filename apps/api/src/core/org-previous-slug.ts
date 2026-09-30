import type { Kysely } from "kysely";
import type { Database } from "../storage/types";

/**
 * Slugs an organization answered to before an operator renamed it, from
 * `metadata.previousSlugs`. External systems (webhook callers, trigger
 * callbacks, MCP clients) keep the URL they were handed, so the old slug
 * must keep resolving to the same org.
 */
export function previousSlugsOf(metadata: unknown): string[] {
  let meta = metadata;
  if (typeof meta === "string") {
    try {
      meta = JSON.parse(meta);
    } catch {
      return [];
    }
  }
  const slugs = (meta as { previousSlugs?: unknown } | null)?.previousSlugs;
  return Array.isArray(slugs)
    ? slugs.filter((s): s is string => typeof s === "string")
    : [];
}

export async function findOrgByPreviousSlug(
  db: Kysely<Database>,
  slug: string,
) {
  // ponytail: LIKE prefilter + JS parse; `metadata` is untyped text, so a
  // jsonb cast would throw on any malformed row.
  const candidates = await db
    .selectFrom("organization")
    .select(["id", "slug", "name", "metadata"])
    .where("metadata", "like", "%previousSlugs%")
    .execute();
  return candidates.find((org) => previousSlugsOf(org.metadata).includes(slug));
}
