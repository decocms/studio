import { z } from "zod";
import { storedExternalRegistration } from "@decocms/shared/deco-analytics";
import type { StudioContext } from "../core/studio-context";
import { lookupOwnedProject } from "../tools/experiments/ownership";
import { readAnalyticsRegistration } from "./registration";

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

/**
 * The warehouse id an owned slug's analytics reads: the registration its
 * project carries when the control-plane doesn't host it, else the
 * control-plane's. The caller has already checked that the org owns `site`.
 */
export async function ownedAnalyticsSiteId(
  ctx: StudioContext,
  organizationId: string,
  site: string,
): Promise<
  | { status: "registered"; id: string }
  | { status: "unregistered" }
  | { status: "error" }
> {
  const lookup = await lookupOwnedProject(ctx, organizationId, site).then(
    (project) => ({ ok: true as const, project }),
    (error: unknown) => ({ ok: false as const, error }),
  );
  const stored =
    lookup.ok && storedExternalRegistration(lookup.project?.metadata);
  if (stored) return { status: "registered", id: stored.id };
  const registration = await readAnalyticsRegistration(site);
  if (registration.status === "error") return { status: "error" };
  // Unhosted, so only the project could have said where its analytics is.
  if (registration.status === "unhosted" && !lookup.ok) {
    console.error(
      `[analytics] registration lookup failed for site="${site}":`,
      lookup.error,
    );
    return { status: "error" };
  }
  return registration.status === "registered"
    ? { status: "registered", id: registration.id }
    : { status: "unregistered" };
}

const UsageScope = z.object({
  usageScope: z.object({
    site: z.string().nullable(),
    reader: z.string(),
    tenantScoped: z.boolean(),
  }),
});

/**
 * Whether a read-surface payload was answered by the tenant-scoped reader for
 * `siteId`. The read surface trusts the master token to name any site, so any
 * other payload could be someone else's numbers and must never render.
 */
export function isTenantScoped(payload: unknown, siteId: string): boolean {
  const parsed = UsageScope.safeParse(payload);
  if (!parsed.success) return false;
  const { site, reader, tenantScoped } = parsed.data.usageScope;
  return tenantScoped && reader === "stats_reader" && site === siteId;
}
