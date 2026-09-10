/**
 * Frontend paths for org-scoped pages.
 *
 * Server-side callers prefix these with whatever base URL they hold —
 * `getPublicUrl()`, `ctx.baseUrl`, an injected one. Those bases are not
 * interchangeable, so this owns the path and nothing else.
 *
 * The point is that a renamed settings route is a compile error at every
 * server-side emitter rather than a link that silently falls through to
 * `/$org/$taskId` and mints a thread named after the page.
 */

/** Settings pages the server links people to. */
export type OrgSettingsPage = "members" | "infra-billing";

/** `/<org>/settings` — or one page under it. */
export function orgSettingsPath(
  orgSlug: string,
  page?: OrgSettingsPage,
): string {
  const base = `/${encodeURIComponent(orgSlug)}/settings`;
  return page ? `${base}/${page}` : base;
}

/**
 * `/<org>/agents/<panel>?virtualmcpid=<id>` — a project's workspace, at one view.
 *
 * The project is a SEARCH param, not a path segment: it has to mean the same
 * thing on `/tasks` and `/library`, which have no segment to put it in.
 *
 * Every server-side emitter of this link goes through here. Two of them mint
 * URLs that outlive us — the report CTA is persisted by the commerce-discovery
 * service per (org, site) and refreshes only when setup re-runs, and share
 * invites sit in delivered mail — so a future rename has to be a compile error
 * here, not a dead link nobody can recall.
 */
export function agentPanelPath(
  orgSlug: string,
  opts: {
    projectId: string;
    panel?: string;
    /** Extra query the panel needs, e.g. the `app` view's connection + tool. */
    search?: Record<string, string>;
  },
): string {
  const base = `/${encodeURIComponent(orgSlug)}/agents`;
  const path = opts.panel ? `${base}/${opts.panel}` : base;
  const query = new URLSearchParams({
    virtualmcpid: opts.projectId,
    ...(opts.search ?? {}),
  });
  return `${path}?${query.toString()}`;
}
