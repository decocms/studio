import { isValidSiteSlug } from "@decocms/shared/site-slug";

/**
 * Agents imported before `metadata.siteSlug` was persisted resolve their asset
 * tenancy (and the storefront "." shortcut) from their title. Renaming one
 * would move that tenancy, so the first rename freezes the outgoing title as
 * the slug — materializing the value that was already in effect.
 *
 * Returns the slug to stamp, or `null` when there is nothing to pin: the agent
 * already has a slug, the title isn't changing, or the outgoing title was never
 * a usable slug (so it resolved nothing to begin with).
 */
export function pinnedSiteSlugOnRename(args: {
  nextTitle: string | undefined;
  currentTitle: string | null | undefined;
  currentSiteSlug: string | null | undefined;
}): string | null {
  const { nextTitle, currentTitle, currentSiteSlug } = args;

  if (currentSiteSlug?.trim()) return null;
  if (nextTitle === undefined || nextTitle === currentTitle) return null;

  const outgoing = currentTitle?.trim().toLowerCase() ?? "";
  return isValidSiteSlug(outgoing) ? outgoing : null;
}
