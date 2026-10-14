import type { StudioContext } from "../../core/studio-context";
import {
  resolveAgentSiteSlug,
  resolveAnalyticsSiteSlug,
} from "@decocms/shared/site-slug";

/**
 * The org's project whose site is `site`. A slug linked in `org_sites` names
 * its project directly; a slug linked to another org's project — or a
 * tombstone (its org was deleted) — is never this org's. Projects not linked
 * yet (several imports of one storefront in an org, slugs never claimed) still
 * match by resolved slug.
 *
 * Known gap, kept for v7 compatibility: an unlinked slug owned by another org
 * still matches this org's look-alike project.
 */
async function findOwnedProject(
  ctx: StudioContext,
  organizationId: string,
  site: string,
) {
  const [vms, row] = await Promise.all([
    ctx.storage.virtualMcps.list(organizationId),
    ctx.storage.orgSites.getBySlug(site),
  ]);
  if (row && row.organizationId === null) {
    throw new Error("Site not found in organization");
  }
  const project = row?.projectId
    ? row.organizationId === organizationId
      ? vms.find((vm) => vm.id === row.projectId)
      : undefined
    : vms.find((vm) => resolveAgentSiteSlug(vm) === site);
  if (!project) {
    throw new Error("Site not found in organization");
  }
  return project;
}

/**
 * Fail unless the org owns a project (VIRTUAL connection) whose site is
 * `site` — its `org_sites` link, else its resolved site slug.
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
