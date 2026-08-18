/**
 * Shared ownership gate for the infra-billing tools: every requested site slug
 * must be owned by the calling org, or the whole call fails — one tool must
 * never leak another org's usage/plan/invoices by guessing a slug.
 */

import type { StudioContext } from "../../core/studio-context";

/**
 * Lowercases + dedupes the requested slugs, loads the org's owned slugs, and
 * throws if any requested slug isn't owned. Returns both lists so callers can
 * reuse `ownedSlugs` for team-scoped checks (e.g. `resolveOwnedTeam`).
 */
export async function resolveOwnedSlugs(
  ctx: StudioContext,
  orgId: string,
  siteSlugs: string[],
): Promise<{ slugs: string[]; ownedSlugs: string[] }> {
  const slugs = [...new Set(siteSlugs.map((s) => s.toLowerCase()))];
  const ownedSlugs = (await ctx.storage.orgSites.listByOrg(orgId)).map(
    (site) => site.slug,
  );
  const owned = new Set(ownedSlugs);
  const unowned = slugs.filter((slug) => !owned.has(slug));
  if (unowned.length > 0) {
    throw new Error(
      `Site not found in organization: ${unowned.sort().join(", ")}`,
    );
  }
  return { slugs, ownedSlugs };
}
