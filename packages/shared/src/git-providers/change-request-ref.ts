/**
 * Pure helpers over a change request's identity — the provider-neutral name for
 * what GitHub calls a pull request and GitLab a merge request.
 *
 * A change request is addressed by its repository plus a per-repository number
 * (GitHub's `number`, GitLab's `iid` — both 1-based and both scoped to the
 * project, which is why one field carries them). Every URL convention lives
 * here so nothing outside this module hand-builds `github.com/.../pull/1`.
 */

import { parseRepoUrl, repoWebUrl } from "./repo-ref";
import type { GitProviderKind, RepoRef } from "./types";

export interface ChangeRequestRef {
  repo: RepoRef;
  /** Per-repository number: GitHub's `number`, GitLab's `iid`. */
  number: number;
  /** Canonical browser URL — the display and dedup key. */
  url: string;
}

/** The provider's browser path for one change request, after the repo path. */
const WEB_SUFFIX: Record<GitProviderKind, string> = {
  github: "pull",
  gitlab: "-/merge_requests",
};

/** Canonical browser URL for a change request. */
export function changeRequestUrl(repo: RepoRef, number: number): string {
  return `${repoWebUrl(repo)}/${WEB_SUFFIX[repo.provider]}/${number}`;
}

/**
 * Every URL shape a change request is quoted as, in the order they are tried.
 *
 * Browser URLs come first so the human-facing link wins over the API one when
 * a `curl` response body carries both. Each pattern captures the host, the
 * repository path and the number; `parseRepoUrl` then does the actual
 * provider/host/path work, so a self-hosted GitLab and a GitHub Enterprise
 * host parse through exactly the same code as the SaaS ones.
 *
 * All are linear (no nested quantifiers) — safe to run on large stdout.
 */
const URL_PATTERNS: { re: RegExp; api?: boolean }[] = [
  // https://<host>/<group/sub/project>/-/merge_requests/<iid>
  { re: /https?:\/\/([^/\s"']+)\/([^\s"']+?)\/-\/merge_requests\/(\d+)/ },
  // https://<host>/<owner>/<repo>/pull/<number>
  { re: /https?:\/\/([^/\s"']+)\/([^/\s"']+\/[^/\s"']+)\/pull\/(\d+)/ },
  // https://api.github.com/repos/<owner>/<repo>/pulls/<number>
  {
    re: /https?:\/\/([^/\s"']+)\/repos\/([^/\s"']+\/[^/\s"']+)\/pulls\/(\d+)/,
    api: true,
  },
  // https://<host>/api/v4/projects/<url-encoded path>/merge_requests/<iid>
  {
    re: /https?:\/\/([^/\s"']+)\/api\/v4\/projects\/([^/\s"']+)\/merge_requests\/(\d+)/,
    api: true,
  },
];

/**
 * `api.github.com` addresses `github.com`'s repositories, and
 * `<host>/api/v4/...` addresses `<host>`'s — so an API match has to be mapped
 * back to the browser host before the repository can be identified.
 */
function webHostOf(host: string): string {
  const h = host.toLowerCase();
  return h === "api.github.com" ? "github.com" : h;
}

function refFrom(
  match: RegExpExecArray,
  api: boolean,
): ChangeRequestRef | null {
  const number = Number(match[3]);
  if (!Number.isSafeInteger(number) || number <= 0) return null;
  const host = webHostOf(match[1]!);
  // A GitLab project may be addressed by its numeric id, which names no path.
  const rawPath = match[2]!;
  const path = api ? decodeURIComponent(rawPath) : rawPath;
  if (/^\d+$/.test(path)) return null;
  const repo = parseRepoUrl(`https://${host}/${path}`);
  if (!repo) return null;
  return { repo, number, url: changeRequestUrl(repo, number) };
}

/**
 * Parse one change request URL. Returns null when the string is not a change
 * request URL or names a repository whose provider cannot be determined.
 */
export function parseChangeRequestUrl(input: string): ChangeRequestRef | null {
  const raw = input.trim();
  if (!raw) return null;
  for (const { re, api } of URL_PATTERNS) {
    const match = re.exec(raw);
    const ref = match ? refFrom(match, api === true) : null;
    if (ref) return ref;
  }
  return null;
}

/**
 * Cap the scan of free-form output. A single linear regex is fine on big
 * input, but a verbose `curl -v` dump can be megabytes — the URL, when
 * present, is near the top (the CLI's own output) or in the response body.
 * 200KB covers both without scanning a whole log.
 */
const MAX_SCAN = 200_000;

/**
 * Find the first change request URL anywhere in a string.
 *
 * Every "the agent opened one" scenario collapses to this: a provider tool
 * result, `gh pr create` / `glab mr create` stdout, and a raw `curl` response
 * body all embed the URL, so callers stringify whatever they have and scan it
 * rather than branching per shape.
 */
export function findChangeRequestUrl(text: string): ChangeRequestRef | null {
  const s = text.length > MAX_SCAN ? text.slice(0, MAX_SCAN) : text;
  for (const { re, api } of URL_PATTERNS) {
    const match = re.exec(s);
    const ref = match ? refFrom(match, api === true) : null;
    if (ref) return ref;
  }
  return null;
}
