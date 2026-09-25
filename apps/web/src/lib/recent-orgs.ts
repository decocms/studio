/**
 * Which organizations the rail draws, for someone who belongs to dozens.
 *
 * The rail lists every org you belong to, which is fine at five and a scroll
 * bar at forty — and a column of forty marks is not navigation, it is a
 * haystack. So the rail shows a bounded set and a search opens the rest.
 *
 * Membership is by RECENCY; order is not.
 *
 * That split is the whole design. Ordering the rail by recency would move
 * every mark each time you switched org — the one you just left slides down,
 * the one you just opened jumps to the top — which destroys the muscle memory
 * that makes an always-visible rail worth having in the first place. Instead
 * recency decides only WHICH orgs are in the set; they are then drawn in the
 * org list's own stable order, so a switch usually moves nothing at all, and
 * the current org is marked rather than repositioned.
 *
 * Pure: the hook owns storage, this owns the rules.
 */

/** How many marks the rail will draw before deferring to search. Seven leaves
 *  room under the orgs for search, "new org" and the recent apps without the
 *  rail needing a scrollbar of its own. */
const RAIL_ORG_LIMIT = 7;

/** Newest first, one entry per slug — reopening an org MOVES it to the front
 *  rather than adding a second copy. Trimmed generously rather than to the
 *  rail's limit: the history is also what search ranks by, and an org that
 *  falls off the rail is not one you have forgotten. */
export function pushRecentOrg(
  list: readonly string[],
  slug: string,
  limit = RAIL_ORG_LIMIT * 3,
): string[] {
  return [slug, ...list.filter((it) => it !== slug)].slice(0, limit);
}

/**
 * Split the orgs you belong to into the ones the rail draws and the count it
 * is hiding.
 *
 * The current org is always in the set even when nothing has been remembered
 * yet — landing on an org by deep link and not seeing it in the rail reads as
 * the rail being broken. Beyond that the set fills from history, then from the
 * list's own order, so a fresh profile still gets a full rail rather than one
 * mark and a search button.
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
