/** Identifies a repository from the URL the site project stores. */

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
