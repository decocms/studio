import { storedExternalRegistration } from "@decocms/shared/deco-analytics";
import type { StudioContext } from "../core/studio-context";
import { lookupOwnedProject } from "../tools/experiments/ownership";

/**
 * How the org may read `site`'s analytics: its project carries the
 * registration ANALYTICS_INSTALL made for a site the control-plane doesn't
 * host (an external site, or an `org_sites` slug the control-plane has no
 * record of), or it owns the slug in `org_sites`. Null when neither; `error`
 * when the project lookup failed for a slug the org doesn't own.
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
  const [owned, lookup] = await Promise.all([
    ctx.storage.orgSites.isOwnedBy(site, organizationId),
    lookupOwnedProject(ctx, organizationId, site).then(
      (project) => ({ ok: true as const, project }),
      (error: unknown) => ({ ok: false as const, error }),
    ),
  ]);
  if (lookup.ok) {
    const stored = storedExternalRegistration(lookup.project?.metadata);
    if (stored) return { kind: "external", siteId: stored.id };
  } else if (!owned) {
    console.error(
      `[analytics] registration lookup failed for site="${site}":`,
      lookup.error,
    );
    return { kind: "error" };
  }
  return owned ? { kind: "owned" } : null;
}
