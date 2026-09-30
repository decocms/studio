/**
 * Which organizations the rail draws, bounded so forty memberships stay
 * navigation rather than a haystack.
 *
 * Membership is by recency; ORDER is not. Recency picks the set, the org
 * list's own stable order draws it, so switching org moves no marks and the
 * rail keeps its muscle memory.
 */

/** What fits a laptop once each mark carries its name underneath
 *  (`rail-item.tsx`), beside search, "new org" and four recent apps. */
const RAIL_ORG_LIMIT = 5;

/** Newest first, one entry per slug. Kept longer than the rail's limit because
 *  search ranks by this history too. */
export function pushRecentOrg(
  list: readonly string[],
  slug: string,
  limit = RAIL_ORG_LIMIT * 3,
): string[] {
  return [slug, ...list.filter((it) => it !== slug)].slice(0, limit);
}

/**
 * The orgs the rail draws, and the count it hides. The current org is always
 * in the set — a deep link landing outside the rail reads as a broken rail —
 * then history, then the list's own order fills the rest.
 */
export function railOrgs<T extends { slug: string }>(
  all: readonly T[],
  recentSlugs: readonly string[],
  currentSlug: string | null,
  limit = RAIL_ORG_LIMIT,
): { shown: T[]; hidden: T[] } {
  if (all.length <= limit) return { shown: [...all], hidden: [] };

  const bySlug = new Map(all.map((org) => [org.slug, org]));
  const picked = new Set<string>();

  if (currentSlug && bySlug.has(currentSlug)) picked.add(currentSlug);
  for (const slug of recentSlugs) {
    if (picked.size >= limit) break;
    if (bySlug.has(slug)) picked.add(slug);
  }
  for (const org of all) {
    if (picked.size >= limit) break;
    picked.add(org.slug);
  }

  return {
    shown: all.filter((org) => picked.has(org.slug)),
    hidden: all.filter((org) => !picked.has(org.slug)),
  };
}
