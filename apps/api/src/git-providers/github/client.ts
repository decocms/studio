/**
 * `GitProviderClient` for GitHub (github.com and GitHub Enterprise).
 *
 * Two modes, picked by the options union:
 * - installation: Studio's GitHub App is installed on the account and tokens
 *   are minted per call through `GithubAppAuth` — repo-scoped for pushes,
 *   read-only account-wide for listing and reading.
 * - token: a user OAuth grant or personal access token supplied by a
 *   `TokenSource`; the same token serves every call.
 */

import {
  apiBaseUrlFor,
  type RepoRef,
  repoName,
  splitOwnerName,
} from "@decocms/shared/git-providers";
import { GITHUB_SCOPED_PERMISSIONS } from "@decocms/shared/github-repo-scope";
import {
  type GitAccessToken,
  type GitIdentity,
  type GitProviderClient,
  GitProviderError,
  type ListReposOptions,
  type RepoSummary,
  type RepoVisibility,
  type TokenOptions,
  type TokenSource,
} from "../types";
import type { GithubAppAuth } from "./app-auth";
import {
  type GithubFetchInit,
  githubFailure,
  githubFetch,
  githubJson,
} from "./http";

export type GithubProviderClientOptions =
  | { host: string; installationId: number; appAuth: GithubAppAuth }
  | { host: string; tokenSource: TokenSource };

/** Enough to list, inspect and read files in every repository of the installation. */
const ACCOUNT_READ_PERMISSIONS: Record<string, string> = {
  metadata: "read",
  contents: "read",
};

const DEFAULT_PER_PAGE = 30;
const MAX_PER_PAGE = 100;

/** Raw-content media type for `GET /repos/{o}/{r}/contents/{path}`. */
const RAW_CONTENT_ACCEPT = "application/vnd.github.raw+json";

/** The fields of GitHub's repository object the mapping reads. */
export interface GithubRepoJson {
  id: number;
  full_name: string;
  private: boolean;
  visibility?: string | null;
  default_branch?: string | null;
  html_url: string;
  description?: string | null;
  pushed_at?: string | null;
  updated_at?: string | null;
}

function isRepoVisibility(value: string): value is RepoVisibility {
  return value === "public" || value === "private" || value === "internal";
}

/** Pure: GitHub repository object → neutral `RepoSummary`. */
export function mapGithubRepo(json: GithubRepoJson, host: string): RepoSummary {
  let visibility: RepoVisibility = "public";
  if (json.private) visibility = "private";
  else if (json.visibility && isRepoVisibility(json.visibility)) {
    visibility = json.visibility;
  }
  return {
    ref: { provider: "github", host, path: json.full_name },
    externalId: String(json.id),
    defaultBranch: json.default_branch ?? null,
    webUrl: json.html_url,
    visibility,
    description: json.description ?? null,
    updatedAt: json.pushed_at ?? json.updated_at ?? null,
  };
}

/**
 * Pure: the client-side `query` filter for repository listings — a
 * case-insensitive substring match over `owner/name`. Empty/blank queries
 * match everything.
 */
export function matchesRepoQuery(
  fullName: string,
  query: string | undefined,
): boolean {
  const needle = query?.trim().toLowerCase();
  if (!needle) return true;
  return fullName.toLowerCase().includes(needle);
}

export interface GithubUserJson {
  login: string;
  name?: string | null;
  email?: string | null;
}

/**
 * Pure: commit author identity for a user token. `/user` omits the email
 * when it is private; GitHub's noreply address keeps the commit attributed.
 */
export function mapGithubIdentity(json: GithubUserJson): GitIdentity {
  return {
    name: json.name || json.login,
    email: json.email || `${json.login}@users.noreply.github.com`,
  };
}

function encodePath(path: string): string {
  return path.split("/").filter(Boolean).map(encodeURIComponent).join("/");
}

export class GithubProviderClient implements GitProviderClient {
  readonly kind = "github" as const;
  readonly host: string;
  private readonly apiBaseUrl: string;
  private readonly options: GithubProviderClientOptions;

  constructor(options: GithubProviderClientOptions) {
    this.options = options;
    this.host = options.host.toLowerCase();
    this.apiBaseUrl = apiBaseUrlFor("github", options.host);
  }

  async tokenForRepo(
    repo: RepoRef,
    opts: TokenOptions = {},
  ): Promise<GitAccessToken> {
    const options = this.options;
    if ("appAuth" in options) {
      const minted = await options.appAuth.installationToken(
        options.installationId,
        {
          repositories: [repoName(repo)],
          permissions: GITHUB_SCOPED_PERMISSIONS,
          bufferMs: opts.bufferMs,
          forceRefresh: opts.forceRefresh,
        },
      );
      return {
        token: minted.token,
        kind: "installation",
        expiresAt: minted.expiresAt,
      };
    }
    return this.sourceToken(options.tokenSource, opts);
  }

  async accountToken(opts: TokenOptions = {}): Promise<GitAccessToken> {
    const options = this.options;
    if ("appAuth" in options) {
      const minted = await options.appAuth.installationToken(
        options.installationId,
        {
          permissions: ACCOUNT_READ_PERMISSIONS,
          bufferMs: opts.bufferMs,
          forceRefresh: opts.forceRefresh,
        },
      );
      return {
        token: minted.token,
        kind: "installation",
        expiresAt: minted.expiresAt,
      };
    }
    return this.sourceToken(options.tokenSource, opts);
  }

  private async sourceToken(
    source: TokenSource,
    opts: TokenOptions,
  ): Promise<GitAccessToken> {
    const token = await source.get(opts);
    if (!token) {
      throw new GitProviderError({
        provider: "github",
        status: 401,
        message: `No usable GitHub token for ${this.host}; reconnect the account`,
      });
    }
    return token;
  }

  async getRepo(repo: RepoRef): Promise<RepoSummary | null> {
    const operation = "get_repo";
    const { owner, name } = splitOwnerName(repo);
    const res = await this.request(
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`,
      { operation },
    );
    if (res.status === 404) return null;
    if (!res.ok) throw await githubFailure(res, operation);
    return mapGithubRepo(
      await githubJson<GithubRepoJson>(res, operation),
      this.host,
    );
  }

  async listRepos(opts: ListReposOptions = {}): Promise<RepoSummary[]> {
    const page = Math.max(1, Math.floor(opts.page ?? 1));
    const perPage = Math.min(
      MAX_PER_PAGE,
      Math.max(1, Math.floor(opts.perPage ?? DEFAULT_PER_PAGE)),
    );
    const paging = `per_page=${perPage}&page=${page}`;

    let repos: GithubRepoJson[];
    if ("appAuth" in this.options) {
      const operation = "list_installation_repositories";
      const res = await this.request(`/installation/repositories?${paging}`, {
        operation,
      });
      if (!res.ok) throw await githubFailure(res, operation);
      const body = await githubJson<{ repositories?: GithubRepoJson[] }>(
        res,
        operation,
      );
      repos = Array.isArray(body.repositories) ? body.repositories : [];
    } else {
      const operation = "list_user_repositories";
      const res = await this.request(
        `/user/repos?affiliation=owner,collaborator,organization_member&sort=pushed&${paging}`,
        { operation },
      );
      if (!res.ok) throw await githubFailure(res, operation);
      const body = await githubJson<GithubRepoJson[]>(res, operation);
      repos = Array.isArray(body) ? body : [];
    }

    return repos
      .filter((r) => matchesRepoQuery(r.full_name, opts.query))
      .map((r) => mapGithubRepo(r, this.host));
  }

  async readFile(
    repo: RepoRef,
    path: string,
    ref?: string,
  ): Promise<string | null> {
    const operation = "read_file";
    const { owner, name } = splitOwnerName(repo);
    const query = ref ? `?ref=${encodeURIComponent(ref)}` : "";
    const res = await this.request(
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/contents/${encodePath(path)}${query}`,
      { operation, accept: RAW_CONTENT_ACCEPT },
    );
    if (res.status === 404) return null;
    if (!res.ok) throw await githubFailure(res, operation);
    return res.text();
  }

  async identity(): Promise<GitIdentity | null> {
    // Installation tokens are not a user: `/user` answers 401 for them.
    if ("appAuth" in this.options) return null;
    const operation = "get_user";
    const res = await this.request("/user", { operation });
    if (!res.ok) throw await githubFailure(res, operation);
    return mapGithubIdentity(await githubJson<GithubUserJson>(res, operation));
  }

  /**
   * One authenticated REST call with the account token. A 401 means the
   * token died before `expiresAt` said so (revoked, rotated): re-mint or
   * refresh once and retry, and let the caller judge the second answer.
   */
  private async request(
    path: string,
    init: Omit<GithubFetchInit, "token">,
  ): Promise<Response> {
    const url = `${this.apiBaseUrl}${path}`;
    const first = await this.accountToken();
    const res = await githubFetch(url, { ...init, token: first.token });
    if (res.status !== 401) return res;
    const refreshed = await this.accountToken({ forceRefresh: true });
    return githubFetch(url, { ...init, token: refreshed.token });
  }
}
