/** Identifies a repository from the URL the site project stores. */
import type { SiteProfile } from "../types.ts";

export type RepoProvider = "github" | "gitlab" | "bitbucket";

/** Provider by host; anything that is not GitLab or Bitbucket is GitHub. */
export function providerOfHost(host: string): RepoProvider {
  if (/(^|\.)gitlab\./i.test(host)) return "gitlab";
  if (/(^|\.)bitbucket\./i.test(host)) return "bitbucket";
  return "github";
}

/** `https://host/owner/name(.git)` → host and path. */
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
  /** `owner/name` (on GitLab, `group/sub/project`). */
  path: string;
  /** The repository's id in Studio (`metadata.repository.repositoryId`). */
  repository_id?: string;
}

/** `owner/name` or a repository URL; without a host, GitHub. */
function parseCodeRepo(raw: string): { host: string; path: string } | null {
  const t = raw.trim();
  if (t.includes("://")) return parseRepoUrl(t);
  const path = t.replace(/^\/+|\/+$/g, "").replace(/\.git$/, "");
  return /^[^/\s]+(\/[^/\s]+)+$/.test(path)
    ? { host: "github.com", path }
    : null;
}

/**
 * The store's repository: the profile's `code_repo` (the override) or the site project's in Studio
 * (`sources.repository`). Without provider/host, GitHub.
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
