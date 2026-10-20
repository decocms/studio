/**
 * Pure helpers over `RepoRef`: URL parsing, identity, clone/web/API URLs.
 *
 * Every provider-specific string convention lives here so the rest of the
 * codebase never hand-builds a `github.com/...` URL again. Pure module.
 */

import type { GitProviderKind, RepoRef } from "./types";

export const DEFAULT_HOSTS: Record<GitProviderKind, string> = {
  github: "github.com",
  gitlab: "gitlab.com",
  bitbucket: "bitbucket.org",
};

/**
 * Username git expects in the userinfo of an HTTPS clone URL, per provider.
 * The sandbox daemon and `TASK_ADD_REPO` switch on this value to tell the
 * providers apart from a clone URL alone, so each must stay distinct.
 */
const CLONE_USERNAMES: Record<GitProviderKind, string> = {
  github: "x-access-token",
  gitlab: "oauth2",
  bitbucket: "x-token-auth",
};

/**
 * Providers whose repository path is exactly `owner/name` (`workspace/slug`
 * on Bitbucket). Only GitLab nests namespaces to arbitrary depth.
 */
const TWO_SEGMENT_PROVIDERS = new Set<GitProviderKind>(["github", "bitbucket"]);

/**
 * Best-effort provider for a host. `github.com`, `gitlab.com` and
 * `bitbucket.org` are certain; a self-hosted GitLab is recognised by
 * convention (`gitlab.` prefix / a `gitlab` label). Anything else is unknown
 * and callers must pass the provider explicitly (an account row always knows
 * its `type`). A self-hosted Bitbucket is deliberately NOT recognised: that is
 * Bitbucket Data Center, whose API and URL shapes this module does not speak.
 */
export function providerForHost(host: string): GitProviderKind | null {
  const h = host.toLowerCase();
  if (h === "github.com" || h === "www.github.com") return "github";
  if (h === "gitlab.com" || h === "www.gitlab.com") return "gitlab";
  if (h === "bitbucket.org" || h === "www.bitbucket.org") return "bitbucket";
  if (/(^|[.-])gitlab([.-]|$)/.test(h)) return "gitlab";
  return null;
}

function normalizeHost(rawHost: string): string {
  const h = rawHost.toLowerCase();
  return h.startsWith("www.") ? h.slice(4) : h;
}

/**
 * Parse a repository URL into a `RepoRef`. Accepts:
 * - `https://host/path[.git]` and browser URLs with a trailing sub-path
 *   (`/pull/1`, `/tree/main`, GitLab's `/-/merge_requests/1`, Bitbucket's
 *   `/pull-requests/1` and `/src/main/...`)
 * - `git@host:path.git`, `ssh://git@host/path.git` and Bitbucket's
 *   `https://user@bitbucket.org/path.git`
 * - a bare `owner/name` when `provider` is given (host defaults per provider)
 *
 * Returns null when the provider cannot be determined or the path has fewer
 * than two segments. GitHub and Bitbucket paths are exactly two segments, so
 * anything after them is a sub-resource and dropped; GitLab paths keep every
 * namespace level.
 */
export function parseRepoUrl(
  input: string,
  opts?: { provider?: GitProviderKind; host?: string },
): RepoRef | null {
  const raw = input.trim();
  if (!raw) return null;

  let host: string;
  let pathname: string;

  const scp = /^(?:[\w.-]+@)?([\w.-]+(?::\d+)?):(?!\/\/)(.+)$/.exec(raw);
  if (scp && !/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) {
    host = scp[1]!;
    pathname = scp[2]!;
  } else if (/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) {
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      return null;
    }
    if (!/^(https?|ssh|git)(\+ssh)?:$/.test(url.protocol)) return null;
    host = url.host;
    pathname = url.pathname;
  } else if (opts?.provider) {
    host = opts.host ?? DEFAULT_HOSTS[opts.provider];
    pathname = raw;
  } else {
    return null;
  }

  host = normalizeHost(host);
  const provider = opts?.provider ?? providerForHost(host);
  if (!provider) return null;

  let segments = pathname
    .split("/")
    .map((s) => s.trim())
    .filter(Boolean);
  // GitLab browser URLs: everything from `/-/` on is a sub-resource.
  const dash = segments.indexOf("-");
  if (dash >= 0) segments = segments.slice(0, dash);
  if (TWO_SEGMENT_PROVIDERS.has(provider)) segments = segments.slice(0, 2);
  if (segments.length < 2) return null;
  const last = segments[segments.length - 1]!;
  segments[segments.length - 1] = last.replace(/\.git$/i, "");
  if (segments.some((s) => s.length === 0 || s === "." || s === "..")) {
    return null;
  }
  return { provider, host, path: segments.join("/") };
}

/**
 * Case-insensitive identity: every provider forbids two repositories whose
 * paths differ only by case inside one namespace, and GitHub resolves
 * `Owner/Name` and `owner/name` to the same repository.
 */
export function repoIdentityKey(ref: Pick<RepoRef, "host" | "path">): string {
  return `${ref.host.toLowerCase()}/${ref.path.toLowerCase()}`;
}

export function sameRepo(
  a: Pick<RepoRef, "host" | "path">,
  b: Pick<RepoRef, "host" | "path">,
): boolean {
  return repoIdentityKey(a) === repoIdentityKey(b);
}

/** Last path segment — the repository's own name. */
export function repoName(ref: Pick<RepoRef, "path">): string {
  const segments = ref.path.split("/");
  return segments[segments.length - 1] ?? ref.path;
}

/** Everything before the last segment — owner (GitHub), workspace (Bitbucket) or namespace (GitLab). */
export function repoNamespace(ref: Pick<RepoRef, "path">): string {
  const i = ref.path.lastIndexOf("/");
  return i < 0 ? "" : ref.path.slice(0, i);
}

/** `{owner, name}` for callers still speaking GitHub's two-segment shape. */
export function splitOwnerName(ref: Pick<RepoRef, "path">): {
  owner: string;
  name: string;
} {
  return { owner: repoNamespace(ref), name: repoName(ref) };
}

export function repoWebUrl(ref: RepoRef): string {
  return `https://${ref.host}/${ref.path}`;
}

/**
 * HTTPS clone URL, with the token embedded as the provider's expected userinfo
 * when given. `git clone` stores it on `origin`, so the daemon needs no other
 * plumbing; the daemon reads the token back out of the same URL.
 */
export function cloneUrlFor(ref: RepoRef, token?: string | null): string {
  const base = `${ref.host}/${ref.path}.git`;
  if (!token) return `https://${base}`;
  const user = CLONE_USERNAMES[ref.provider];
  return `https://${user}:${encodeURIComponent(token)}@${base}`;
}

/**
 * REST API base for a provider host (GitHub Enterprise and self-hosted GitLab
 * included). Bitbucket is Bitbucket Cloud only: its API lives on a separate
 * host, and a self-hosted Data Center instance speaks a different API that no
 * client here implements, so the host is not consulted.
 */
export function apiBaseUrlFor(provider: GitProviderKind, host: string): string {
  const h = normalizeHost(host);
  switch (provider) {
    case "github":
      return h === "github.com"
        ? "https://api.github.com"
        : `https://${h}/api/v3`;
    case "gitlab":
      return `https://${h}/api/v4`;
    case "bitbucket":
      return "https://api.bitbucket.org/2.0";
  }
}

/** Build a `RepoRef` from GitHub's legacy `owner`/`name` pair. */
export function repoRefFromOwnerName(owner: string, name: string): RepoRef {
  return {
    provider: "github",
    host: DEFAULT_HOSTS.github,
    path: `${owner}/${name}`,
  };
}
