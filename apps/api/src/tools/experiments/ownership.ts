import type { StudioContext } from "../../core/studio-context";

/**
 * Fail unless the org owns the site slug. Experiment rows are already scoped by
 * `organization_id`, so this is not a cross-tenant leak guard — it stops an org
 * from creating/reading experiments for a slug it does not own (which would be
 * meaningless rows), and keeps the CRUD tools consistent with EXPERIMENT_RESULTS.
 * 404-style message, indistinguishable from a non-existent slug.
 */
export async function assertOwnsSite(
  ctx: StudioContext,
  organizationId: string,
  site: string,
): Promise<void> {
  const owned = await ctx.storage.orgSites.isOwnedBy(site, organizationId);
  if (!owned) {
    throw new Error("Site not found in organization");
  }
}
