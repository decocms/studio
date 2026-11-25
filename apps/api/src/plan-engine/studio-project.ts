/**
 * O projeto do site no Studio — de onde o diagnóstico tira domínio, slug do
 * Deco Analytics e repositório sem perguntar nada a ninguém.
 *
 * No Studio, cada site é um Virtual MCP com `metadata.siteSlug`. O
 * `siteSlug` é o `<site>` da rota do heatmap; o `productionUrl` é o domínio
 * público; o `repository` é o repo que a via de repositórios do Studio lê
 * (`url` traz o host; `repositoryId`, quando há, é o id dele no Studio).
 */

import { normalizeDomain } from "./benchmark.ts";
import { parseRepoUrl, providerOfHost } from "./verify/studio-repo.ts";

export interface StudioProject {
  id: string;
  title: string;
  site_slug: string;
  /** Domínio público, sem protocolo. NULL quando o projeto não tem produção. */
  domain: string | null;
  repository: {
    owner: string;
    name: string;
    connection_id: string | null;
    provider?: "github" | "gitlab" | "bitbucket";
    host?: string;
    repository_id?: string;
  } | null;
  /** `deno` (fresh), `bun` (tanstack)… */
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

/**
 * Qual dos projetos é a loja. Uma org pode ter mais de um site (o de
 * produção e uma migração em andamento): vence o que bate com o domínio já
 * conhecido; senão o que está em produção; no empate, o do mesmo slug da org.
 */
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
 * Se o projeto escolhido É a loja do perfil. Só o domínio de produção prova
 * isso: um projeto sem `productionUrl` pode ser qualquer Virtual MCP com
 * `siteSlug` (um servidor MCP da própria loja, por exemplo), e adotar o
 * slug dele manda o Analytics ler o site errado sem nenhum aviso.
 */
export function projectConfirmsStore(
  project: Pick<StudioProject, "domain">,
  domain: string,
): boolean {
  const bare = (d: string) => d.replace(/^www\./, "");
  return project.domain !== null && bare(project.domain) === bare(domain);
}

/**
 * O slug do Deco Analytics da loja quando nenhum projeto declara o domínio:
 * tenta o projeto do domínio, depois o de mesmo slug da org, depois os demais,
 * e fica com o primeiro que o Analytics já conhece. Um probe que falha vale
 * como não registrado.
 */
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
