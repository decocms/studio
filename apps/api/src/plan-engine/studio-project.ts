/**
 * The site's project in Studio: where the diagnosis gets the domain, the Deco
 * Analytics slug and the repository without asking anyone. Each site is a
 * Virtual MCP with `metadata.siteSlug` (the heatmap route's `<site>`);
 * `productionUrl` is the public domain; `repository` is the repo Studio reads.
 */

import { normalizeDomain } from "./benchmark.ts";
import { parseRepoUrl, providerOfHost } from "./verify/studio-repo.ts";

export interface StudioProject {
  id: string;
  title: string;
  site_slug: string;
  /** Public domain, without protocol. NULL when the project has no production. */
  domain: string | null;
  repository: {
    owner: string;
    name: string;
    connection_id: string | null;
    provider?: "github" | "gitlab" | "bitbucket";
    host?: string;
    repository_id?: string;
  } | null;
  /** `deno` (fresh), `bun` (tanstack)... */
  runtime: string | null;
}

export interface VirtualMcpItem {
  id?: unknown;
  title?: unknown;
  metadata?: {
    siteSlug?: unknown;
    previewServerUrl?: unknown;
    productionUrl?: unknown;
    repository?: {
      owner?: unknown;
      name?: unknown;
      connectionId?: unknown;
      url?: unknown;
      repositoryId?: unknown;
    };
    runtime?: { selected?: unknown };
  } | null;
}

const text = (v: unknown): string | null =>
  typeof v === "string" && v.trim() ? v.trim() : null;

export function toStudioProject(item: VirtualMcpItem): StudioProject | null {
  const meta = item.metadata;
  const siteSlug = text(meta?.siteSlug);
  if (!meta || !siteSlug) return null;
  const domain =
    [meta.previewServerUrl, meta.productionUrl]
      .map((url) => text(url))
      .map((url) => (url ? normalizeDomain(url) : null))
      .find((host) => host !== null && !host.endsWith(".deco.site")) ?? null;
  const owner = text(meta.repository?.owner);
  const name = text(meta.repository?.name);
  const url = text(meta.repository?.url);
  const host = url ? parseRepoUrl(url)?.host : undefined;
  const repositoryId = text(meta.repository?.repositoryId);
  return {
    id: text(item.id) ?? "",
    title: text(item.title) ?? siteSlug,
    site_slug: siteSlug,
    domain,
    repository:
      owner && name
        ? {
            owner,
            name,
            connection_id: text(meta.repository?.connectionId),
            ...(host ? { provider: providerOfHost(host), host } : {}),
            ...(repositoryId ? { repository_id: repositoryId } : {}),
          }
        : null,
    runtime: text(meta.runtime?.selected),
  };
}

/** Which project is the store: the one matching the known domain, else the one in production, then the one with the org's slug. */
export function pickStudioProject(
  items: readonly VirtualMcpItem[],
  opts: { orgSlug: string; domain?: string | null },
): StudioProject | null {
  const projects = items
    .map(toStudioProject)
    .filter((p): p is StudioProject => p !== null);
  if (projects.length === 0) return null;
  const bare = (d: string) => d.replace(/^www\./, "");
  const known = opts.domain ? bare(opts.domain) : null;
  const score = (p: StudioProject) =>
    (known && p.domain && bare(p.domain) === known ? 8 : 0) +
    (p.domain ? 4 : 0) +
    (p.site_slug === opts.orgSlug ? 2 : 0) +
    (p.repository?.connection_id ? 1 : 0);
  return [...projects].sort((a, b) => score(b) - score(a))[0] ?? null;
}

/**
 * Whether the chosen project IS the profile's store. Only the production domain
 * proves it: adopting the slug of an unrelated Virtual MCP makes Analytics read
 * the wrong site silently.
 */
export function projectConfirmsStore(
  project: Pick<StudioProject, "domain">,
  domain: string,
): boolean {
  const bare = (d: string) => d.replace(/^www\./, "");
  return project.domain !== null && bare(project.domain) === bare(domain);
}

/** The store's Deco Analytics slug when no project declares the domain: tries candidate projects and keeps the first Analytics knows; a failed probe counts as unregistered. */
export async function findAnalyticsSite(
  projects: readonly StudioProject[],
  isRegistered: (slug: string) => Promise<boolean>,
  opts: { orgSlug: string; domain: string | null },
): Promise<string | null> {
  const bare = (d: string) => d.replace(/^www\./, "");
  const known = opts.domain ? bare(opts.domain) : null;
  const rank = (p: StudioProject) =>
    known && p.domain && bare(p.domain) === known
      ? 0
      : p.site_slug === opts.orgSlug
        ? 1
        : 2;
  const ordered = [...projects].sort((a, b) => rank(a) - rank(b));
  for (const { site_slug } of ordered) {
    const registered = await isRegistered(site_slug).catch(() => false);
    if (registered) return site_slug;
  }
  return null;
}
