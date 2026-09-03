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

/** Canonical root of one agent's workspace. */
function agentWorkspacePath(orgSlug: string, agentId: string): string {
  return `/${encodeURIComponent(orgSlug)}/agents/${encodeURIComponent(agentId)}`;
}

export interface AgentAppPathOptions {
  agentId: string;
  connectionId: string;
  toolName: string;
  /** App-owned search in addition to the identity encoded by the path. */
  search?: Readonly<Record<string, string>> & {
    virtualmcpid?: never;
    main?: never;
    connection?: never;
    tool?: never;
  };
}

/** Canonical URL for a tool-rendered app belonging to one agent. */
export function agentAppPath(
  orgSlug: string,
  opts: AgentAppPathOptions,
): string {
  const path = `${agentWorkspacePath(orgSlug, opts.agentId)}/apps/${encodeURIComponent(opts.connectionId)}/${encodeURIComponent(opts.toolName)}`;
  const query = new URLSearchParams(opts.search ?? {});
  return query.size > 0 ? `${path}?${query.toString()}` : path;
}
