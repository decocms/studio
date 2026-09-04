/**
 * GitLab REST v4 client. One instance per account row; the `TokenSource`
 * decides whether the bearer is an OAuth grant or a personal/project access
 * token — GitLab accepts both as `Authorization: Bearer`.
 *
 * Self-managed instances are supported through `host`: every URL is derived
 * from `apiBaseUrlFor("gitlab", host)`.
 */

import {
  apiBaseUrlFor,
  type RepoRef,
  repoWebUrl,
} from "@decocms/shared/git-providers";
import { z } from "zod";
import {
  type GitAccessToken,
  type GitIdentity,
  type GitProviderClient,
  GitProviderError,
  type ListReposOptions,
  type ProviderPrincipal,
  type RepoSummary,
  type TokenOptions,
  type TokenSource,
} from "../types";

const REQUEST_TIMEOUT_MS = 15_000;
/** A whole-repo archive is a download, not a REST call — it needs room to stream. */
const ARCHIVE_TIMEOUT_MS = 60_000;
const DEFAULT_PER_PAGE = 30;
const MAX_PER_PAGE = 100;

/**
 * GitLab addresses a project by its URL-encoded full path, slashes included:
 * `group/sub/project` → `group%2Fsub%2Fproject`.
 */
export function encodeProjectPath(path: string): string {
  return encodeURIComponent(path);
}

/** Repository file paths follow the same rule: `src/app.ts` → `src%2Fapp.ts`. */
export function encodeFilePath(path: string): string {
  return encodeURIComponent(path.replace(/^\/+/, ""));
}

/**
 * Pure: API path+query of the gzipped-tar archive endpoint for `repo` at
 * `ref`. Omitting `sha` leaves GitLab on the project's default branch.
 */
export function gitlabArchivePath(repo: RepoRef, ref?: string): string {
  const base = `/projects/${encodeProjectPath(repo.path)}/repository/archive.tar.gz`;
  return ref ? `${base}?sha=${encodeURIComponent(ref)}` : base;
}

/**
 * How long GitLab asked us to wait, in ms, or null when it did not say.
 * `Retry-After` is seconds (or an HTTP date); `RateLimit-Reset` is an
 * absolute epoch-seconds instant. `now` is injected so the conversion is
 * testable.
 */
export function gitlabRetryAfterMs(
  headers: Headers,
  now: number = Date.now(),
): number | null {
  const retryAfter = headers.get("retry-after");
  if (retryAfter !== null) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
    const at = Date.parse(retryAfter);
    if (Number.isFinite(at)) return Math.max(0, at - now);
  }
  const reset = headers.get("ratelimit-reset");
  if (reset !== null) {
    const epochSeconds = Number(reset);
    if (Number.isFinite(epochSeconds)) {
      return Math.max(0, epochSeconds * 1000 - now);
    }
  }
  return null;
}

const GitlabProjectSchema = z.object({
  id: z.number(),
  path_with_namespace: z.string().min(1),
  default_branch: z.string().nullish(),
  web_url: z.string().nullish(),
  visibility: z.enum(["public", "private", "internal"]),
  description: z.string().nullish(),
  last_activity_at: z.string().nullish(),
});
export type GitlabProject = z.infer<typeof GitlabProjectSchema>;

/** Map a `/projects/:id` payload to the provider-neutral summary. */
export function mapGitlabProject(json: unknown, host: string): RepoSummary {
  const project = GitlabProjectSchema.parse(json);
  const ref: RepoRef = {
    provider: "gitlab",
    host,
    path: project.path_with_namespace,
  };
  return {
    ref,
    externalId: String(project.id),
    defaultBranch: project.default_branch ?? null,
    webUrl: project.web_url ?? repoWebUrl(ref),
    visibility: project.visibility,
    description: project.description ?? null,
    updatedAt: project.last_activity_at ?? null,
  };
}

const GitlabUserSchema = z.object({
  id: z.number(),
  username: z.string().min(1),
  name: z.string().nullish(),
  avatar_url: z.string().nullish(),
  email: z.string().nullish(),
  public_email: z.string().nullish(),
  commit_email: z.string().nullish(),
});
type GitlabUser = z.infer<typeof GitlabUserSchema>;

function describeCause(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

async function errorMessage(res: Response): Promise<string> {
  const text = await res.text().catch(() => "");
  if (!text) return res.statusText || `HTTP ${res.status}`;
  try {
    const json = JSON.parse(text) as { message?: unknown; error?: unknown };
    if (typeof json.message === "string") return json.message;
    if (typeof json.error === "string") return json.error;
  } catch {
    // Not JSON: fall through to the raw body.
  }
  return text.slice(0, 200);
}

/**
 * Authenticated GET against the GitLab API. 404 resolves to null so callers
 * can express "not found" without try/catch; every other non-2xx becomes a
 * `GitProviderError`, with a wait hint when GitLab rate-limited us.
 */
async function gitlabRequest(
  url: string,
  token: string,
  init: { accept?: string; timeoutMs?: number } = {},
): Promise<Response | null> {
  let res: Response;
  try {
    res = await fetch(url, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: init.accept ?? "application/json",
      },
      signal: AbortSignal.timeout(init.timeoutMs ?? REQUEST_TIMEOUT_MS),
    });
  } catch (cause) {
    throw new GitProviderError({
      provider: "gitlab",
      status: 0,
      message: `GitLab request failed: ${describeCause(cause)}`,
      cause,
    });
  }
  if (res.status === 404) return null;
  if (!res.ok) {
    throw new GitProviderError({
      provider: "gitlab",
      status: res.status,
      message: `GitLab API ${res.status}: ${await errorMessage(res)}`,
      retryAfterMs: res.status === 429 ? gitlabRetryAfterMs(res.headers) : null,
    });
  }
  return res;
}

async function fetchGitlabUser(
  host: string,
  token: string,
): Promise<GitlabUser> {
  const res = await gitlabRequest(
    `${apiBaseUrlFor("gitlab", host)}/user`,
    token,
  );
  if (!res) {
    throw new GitProviderError({
      provider: "gitlab",
      status: 404,
      message: "GitLab did not recognise the authenticated user",
    });
  }
  return GitlabUserSchema.parse(await res.json());
}

/**
 * Who a token authenticates as. The routes call this to validate a pasted
 * access token and to seed the account row (`externalAccountId`, `login`).
 */
export async function gitlabCurrentUser(
  host: string,
  token: string,
): Promise<ProviderPrincipal> {
  const user = await fetchGitlabUser(host, token);
  return {
    externalAccountId: String(user.id),
    login: user.username,
    avatarUrl: user.avatar_url ?? null,
  };
}

export class GitlabProviderClient implements GitProviderClient {
  readonly kind = "gitlab" as const;
  readonly host: string;
  private readonly apiBase: string;
  private readonly tokenSource: TokenSource;

  constructor(params: { host: string; tokenSource: TokenSource }) {
    this.host = params.host;
    this.apiBase = apiBaseUrlFor("gitlab", params.host);
    this.tokenSource = params.tokenSource;
  }

  async tokenForRepo(
    _repo: RepoRef,
    opts?: TokenOptions,
  ): Promise<GitAccessToken> {
    return this.accountToken(opts);
  }

  async accountToken(opts?: TokenOptions): Promise<GitAccessToken> {
    const token = await this.tokenSource.get(opts);
    if (!token) {
      throw new GitProviderError({
        provider: "gitlab",
        status: 401,
        message: "GitLab account is not authenticated",
      });
    }
    return token;
  }

  async getRepo(repo: RepoRef): Promise<RepoSummary | null> {
    const res = await this.get(`/projects/${encodeProjectPath(repo.path)}`);
    if (!res) return null;
    return mapGitlabProject(await res.json(), this.host);
  }

  async listRepos(opts: ListReposOptions = {}): Promise<RepoSummary[]> {
    const params = new URLSearchParams({
      membership: "true",
      // The simple representation still carries every field the summary needs.
      simple: "true",
      // By id: gitlab.com 500s when `membership=true` is ordered by activity.
      order_by: "id",
      sort: "desc",
      per_page: String(
        Math.min(MAX_PER_PAGE, Math.max(1, opts.perPage ?? DEFAULT_PER_PAGE)),
      ),
      page: String(Math.max(1, opts.page ?? 1)),
    });
    const query = opts.query?.trim();
    if (query) params.set("search", query);
    const res = await this.get(`/projects?${params}`);
    if (!res) return [];
    const json = await res.json();
    if (!Array.isArray(json)) {
      throw new GitProviderError({
        provider: "gitlab",
        status: 502,
        message: "GitLab /projects returned a non-array payload",
      });
    }
    return json.map((project) => mapGitlabProject(project, this.host));
  }

  async readFile(
    repo: RepoRef,
    path: string,
    ref?: string,
  ): Promise<string | null> {
    let branch = ref;
    if (!branch) {
      const summary = await this.getRepo(repo);
      if (!summary?.defaultBranch) return null;
      branch = summary.defaultBranch;
    }
    const res = await this.get(
      `/projects/${encodeProjectPath(repo.path)}/repository/files/${encodeFilePath(path)}/raw?ref=${encodeURIComponent(branch)}`,
      { accept: "text/plain, */*" },
    );
    if (!res) return null;
    return res.text();
  }

  async archiveTarball(
    repo: RepoRef,
    ref?: string,
  ): Promise<ReadableStream<Uint8Array> | null> {
    const { token } = await this.tokenForRepo(repo);
    const res = await gitlabRequest(
      `${this.apiBase}${gitlabArchivePath(repo, ref)}`,
      token,
      {
        accept: "application/octet-stream, */*",
        timeoutMs: ARCHIVE_TIMEOUT_MS,
      },
    );
    return res?.body ?? null;
  }

  async identity(): Promise<GitIdentity | null> {
    const { token } = await this.accountToken();
    const user = await fetchGitlabUser(this.host, token);
    return {
      name: user.name || user.username,
      email:
        user.commit_email ||
        user.public_email ||
        user.email ||
        `${user.username}@users.noreply.${this.host}`,
    };
  }

  private async get(
    pathAndQuery: string,
    init?: { accept?: string },
  ): Promise<Response | null> {
    const { token } = await this.accountToken();
    return gitlabRequest(`${this.apiBase}${pathAndQuery}`, token, init);
  }
}
