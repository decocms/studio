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
