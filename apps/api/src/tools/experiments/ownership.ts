import type { StudioContext } from "../../core/studio-context";
import {
  resolveAgentSiteSlug,
  resolveAnalyticsSiteSlug,
} from "@decocms/shared/site-slug";

async function findOwnedProject(
  ctx: StudioContext,
  organizationId: string,
  site: string,
) {
  const vms = await ctx.storage.virtualMcps.list(organizationId);
  const project = vms.find((vm) => resolveAgentSiteSlug(vm) === site);
  if (!project) {
    throw new Error("Site not found in organization");
  }
  return project;
}

/**
 * Fail unless the org owns a project (VIRTUAL connection) whose resolved site
 * slug is `site` — a Studio site lives in `connections`, not `org_sites`.
 */
export async function assertOwnsSite(
  ctx: StudioContext,
  organizationId: string,
  site: string,
): Promise<void> {
  await findOwnedProject(ctx, organizationId, site);
}

/**
 * The analytics site slug for the org's project `site`: the project's
 * `analyticsSiteSlug` override when the org also owns that slug in `org_sites`,
 * else `site` itself. Analytics is keyed globally by slug, so an override the org
 * does not own is ignored — it must never read another tenant's traffic.
 */
export async function resolveOwnedAnalyticsSite(
  ctx: StudioContext,
  organizationId: string,
  site: string,
): Promise<string> {
  const project = await findOwnedProject(ctx, organizationId, site);
  const analytics = resolveAnalyticsSiteSlug(project) ?? site;
  if (analytics === site) return site;
  const owned = await ctx.storage.orgSites.isOwnedBy(analytics, organizationId);
  return owned ? analytics : site;
}
