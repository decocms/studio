/** Identificação de um repositório pela URL que o projeto do site guarda. */
import type { SiteProfile } from "../types.ts";

export type RepoProvider = "github" | "gitlab" | "bitbucket";

/** Provedor pelo host; o que não é GitLab nem Bitbucket fica GitHub. */
export function providerOfHost(host: string): RepoProvider {
  if (/(^|\.)gitlab\./i.test(host)) return "gitlab";
  if (/(^|\.)bitbucket\./i.test(host)) return "bitbucket";
  return "github";
}

/** `https://host/owner/nome(.git)` → host e caminho. */
export function parseRepoUrl(
  url: string,
): { host: string; path: string } | null {
  try {
    const u = new URL(url);
    const path = u.pathname.replace(/^\/+|\/+$/g, "").replace(/\.git$/, "");
    return u.hostname && path.includes("/")
      ? { host: u.hostname.toLowerCase(), path }
      : null;
  } catch {
    return null;
  }
}

export interface RepoIdentity {
  provider: RepoProvider;
  host: string;
  /** `owner/nome` (no GitLab, `grupo/sub/projeto`). */
  path: string;
  /** O id do repositório no Studio (`metadata.repository.repositoryId`). */
  repository_id?: string;
}

/** `owner/nome` ou uma URL do repositório; sem host, GitHub. */
function parseCodeRepo(raw: string): { host: string; path: string } | null {
  const t = raw.trim();
  if (t.includes("://")) return parseRepoUrl(t);
  const path = t.replace(/^\/+|\/+$/g, "").replace(/\.git$/, "");
  return /^[^/\s]+(\/[^/\s]+)+$/.test(path)
    ? { host: "github.com", path }
    : null;
}

/**
 * O repositório da loja: o `code_repo` do perfil (o override) ou o do projeto
 * do site no Studio (`sources.repository`). Sem provedor/host, GitHub.
 */
export function repoIdentityOf(
  profile: Pick<SiteProfile, "code_repo" | "sources"> | null,
): RepoIdentity | null {
  const detected = profile?.sources?.repository ?? null;
  const fromSources: RepoIdentity | null = detected
    ? {
        host: detected.host ?? "github.com",
        provider:
          detected.provider ?? providerOfHost(detected.host ?? "github.com"),
        path: `${detected.owner}/${detected.name}`,
        ...(detected.repository_id
          ? { repository_id: detected.repository_id }
          : {}),
      }
    : null;
  const override = profile?.code_repo ? parseCodeRepo(profile.code_repo) : null;
  if (!override) return fromSources;
  if (
    fromSources &&
    fromSources.path.toLowerCase() === override.path.toLowerCase() &&
    fromSources.host === override.host
  ) {
    return fromSources;
  }
  return {
    host: override.host,
    provider: providerOfHost(override.host),
    path: override.path,
  };
}
