/** Identificação de um repositório pela URL que o projeto do site guarda. */

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
