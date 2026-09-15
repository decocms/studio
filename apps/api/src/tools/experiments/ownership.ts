import type { StudioContext } from "../../core/studio-context";
import { resolveAgentSiteSlug } from "@decocms/shared/site-slug";

/**
 * Fail unless the org owns a project (VIRTUAL connection) whose resolved site
 * slug is `site` — a Studio site lives in `connections`, not `org_sites`. Guards
 * EXPERIMENT_RESULTS against reading another tenant's slug-keyed analytics.
 */
export async function assertOwnsSite(
  ctx: StudioContext,
  organizationId: string,
  site: string,
): Promise<void> {
  const vms = await ctx.storage.virtualMcps.list(organizationId);
  const owned = vms.some((vm) => resolveAgentSiteSlug(vm) === site);
  if (!owned) {
    throw new Error("Site not found in organization");
  }
}
