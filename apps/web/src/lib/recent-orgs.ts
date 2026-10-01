/**
 * Which organizations the rail draws, bounded so forty memberships stay
 * navigation rather than a haystack.
 *
 * Membership is by recency; ORDER is not. Recency picks the set, the org
 * list's own stable order draws it, so switching org moves no marks and the
 * rail keeps its muscle memory.
 */

/** The rail's org count is set by the window's height, between these. */
const RAIL_ORG_MIN = 3;
const RAIL_ORG_MAX = 10;
/** Height the rest of the rail claims: search, "new org", the rule and four
 *  labelled recent apps, plus the rail's own padding. */
const RAIL_RESERVED_PX = 440;
/** One org mark (36px) and its gap, rounded up so the rail keeps air. */
const RAIL_ORG_SLOT_PX = 55;

/** How many orgs the rail draws in a window this tall: about 3 on a small
 *  laptop, 7 at ~830px, 10 on a large desktop. */
export function railOrgLimit(windowHeight: number): number {
  const fits = Math.floor((windowHeight - RAIL_RESERVED_PX) / RAIL_ORG_SLOT_PX);
  return Math.min(RAIL_ORG_MAX, Math.max(RAIL_ORG_MIN, fits));
}

/** Newest first, one entry per slug. Kept longer than the rail's limit because
 *  search ranks by this history too. `keep` is what the rail shows now: it goes
 *  right behind `slug`, so switching to an org already on the rail cannot push
 *  another one out of the first entries that `railOrgs`
 *  reads. */
export function pushRecentOrg(
  list: readonly string[],
  slug: string,
  limit = RAIL_ORG_MAX * 3,
  keep: readonly string[] = [],
): string[] {
  return [...new Set([slug, ...keep, ...list])].slice(0, limit);
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
  limit: number,
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
