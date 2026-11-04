import { storedExternalRegistration } from "@decocms/shared/deco-analytics";
import type { StudioContext } from "../core/studio-context";
import { lookupOwnedProject } from "../tools/experiments/ownership";

/**
 * How the org may read `site`'s analytics: it owns the slug in `org_sites`, or,
 * for a site deco doesn't host (never in `org_sites`), its project carries the
 * registration ANALYTICS_INSTALL made for it. Null when neither; `error` when
 * the project lookup failed.
 */
export async function analyticsAccess(
  ctx: StudioContext,
  organizationId: string,
  site: string,
): Promise<
  | { kind: "owned" }
  | { kind: "external"; siteId: string }
  | { kind: "error" }
  | null
> {
  if (await ctx.storage.orgSites.isOwnedBy(site, organizationId)) {
    return { kind: "owned" };
  }
  try {
    const project = await lookupOwnedProject(ctx, organizationId, site);
    const stored = storedExternalRegistration(project?.metadata);
    return stored ? { kind: "external", siteId: stored.id } : null;
  } catch (err) {
    console.error(
      `[analytics] registration lookup failed for site="${site}":`,
      err,
    );
    return { kind: "error" };
  }
}
