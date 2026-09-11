/**
 * Bitbucket Cloud REST 2.0 client. One instance per account row; the
 * `TokenSource` decides whether the bearer is an OAuth grant or a workspace /
 * project / repository access token — Bitbucket accepts all of them as
 * `Authorization: Bearer`.
 *
 * A repository is addressed as `workspace/repo_slug`, exactly two segments,
 * so `RepoRef.path` splits without encoding tricks. Bitbucket Cloud only —
 * see `http.ts`.
 */

import {
  type RepoRef,
  repoWebUrl,
  splitOwnerName,
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
import { BITBUCKET_HOST } from "./env";
import {
  assertBitbucketCloud,
  BITBUCKET_API_BASE,
  bbqString,
  bitbucketFailure,
  bitbucketFetch,
  bitbucketJson,
  type BitbucketPage,
} from "./http";

/** A whole-repo archive is a download, not a REST call — it needs room to stream. */
const ARCHIVE_TIMEOUT_MS = 60_000;
const DEFAULT_PER_PAGE = 30;
const MAX_PER_PAGE = 100;

/**
 * `workspace` and `repo_slug` for a Bitbucket path. Throws for anything but
 * two segments: a `RepoRef` built by `parseRepoUrl` never has more, so a bad
 * one here is a caller passing another provider's ref.
 */
export function splitBitbucketPath(path: string): {
  workspace: string;
  slug: string;
} {
  const { owner: workspace, name: slug } = splitOwnerName({ path });
  if (!workspace || !slug || workspace.includes("/")) {
    throw new GitProviderError({
      provider: "bitbucket",
      status: 400,
      message: `${path} is not a Bitbucket repository path (expected workspace/repo_slug)`,
    });
  }
  return { workspace, slug };
}

/** `/repositories/{workspace}/{repo_slug}` — the prefix of every repository call. */
export function repositoryApiPath(repo: Pick<RepoRef, "path">): string {
  const { workspace, slug } = splitBitbucketPath(repo.path);
  return `/repositories/${encodeURIComponent(workspace)}/${encodeURIComponent(slug)}`;
}

/**
 * The web host's archive download. The REST API has no archive endpoint; this
 * is the same URL the "Download repository" button uses, and it accepts the
 * repository credential.
 */
export function bitbucketArchiveUrl(repo: RepoRef, ref: string): string {
  return `${repoWebUrl(repo)}/get/${encodeURIComponent(ref)}.tar.gz`;
}

const BitbucketRepositorySchema = z.object({
  uuid: z.string().min(1),
  full_name: z.string().min(1),
  is_private: z.boolean(),
  description: z.string().nullish(),
  mainbranch: z.object({ name: z.string().nullish() }).nullish(),
  links: z.object({ html: z.object({ href: z.string() }).nullish() }).nullish(),
  updated_on: z.string().nullish(),
});
export type BitbucketRepository = z.infer<typeof BitbucketRepositorySchema>;

/**
 * Map a `/repositories/{ws}/{slug}` payload to the provider-neutral summary.
 * Bitbucket has no "internal" visibility — a repository is private or it is
 * not.
 */
export function mapBitbucketRepository(
  json: unknown,
  host: string,
): RepoSummary {
  const repository = BitbucketRepositorySchema.parse(json);
  const ref: RepoRef = {
    provider: "bitbucket",
    host,
    path: repository.full_name,
  };
  return {
    ref,
    externalId: repository.uuid,
    defaultBranch: repository.mainbranch?.name ?? null,
    webUrl: repository.links?.html?.href ?? repoWebUrl(ref),
    visibility: repository.is_private ? "private" : "public",
    description: repository.description ?? null,
    updatedAt: repository.updated_on ?? null,
  };
}

const AvatarLinksSchema = z
  .object({ avatar: z.object({ href: z.string().nullish() }).nullish() })
  .nullish();

const BitbucketUserSchema = z.object({
  uuid: z.string().min(1),
  nickname: z.string().min(1),
  display_name: z.string().nullish(),
  links: AvatarLinksSchema,
});

const BitbucketWorkspaceSchema = z.object({
  uuid: z.string().min(1),
  slug: z.string().min(1),
  links: AvatarLinksSchema,
});

/**
 * Who a token authenticates as. The routes call this to validate a pasted
 * access token and to seed the account row (`externalAccountId`, `login`).
 *
 * Three answers are tried because Bitbucket's tokens are not all users: an
 * OAuth grant or a user-level token answers `/user`; a workspace or project
 * access token is refused there (it has no user) but can list its own
 * workspace; a repository access token can do neither and is identified by
 * the workspace of the repository it belongs to. The last refusal is the one
 * surfaced when nothing works.
 */
export async function bitbucketPrincipalForToken(
  host: string,
  token: string,
): Promise<ProviderPrincipal> {
  assertBitbucketCloud(host);
  const user = await tryJson(`${BITBUCKET_API_BASE}/user`, token);
  if (user.ok) {
    const parsed = BitbucketUserSchema.parse(user.json);
    return {
      externalAccountId: parsed.uuid,
      login: parsed.nickname,
      avatarUrl: parsed.links?.avatar?.href ?? null,
    };
  }
  const workspaces = await tryJson(
    `${BITBUCKET_API_BASE}/workspaces?pagelen=1`,
    token,
  );
  if (workspaces.ok) {
    const first = (workspaces.json as BitbucketPage<unknown>).values?.[0];
    if (first !== undefined) return workspacePrincipal(first);
  }
  const repositories = await tryJson(
    `${BITBUCKET_API_BASE}/repositories?role=member&pagelen=1`,
    token,
  );
  if (repositories.ok) {
    const first = (repositories.json as BitbucketPage<{ workspace?: unknown }>)
      .values?.[0];
    if (first?.workspace !== undefined) {
      return workspacePrincipal(first.workspace);
    }
  }
  throw repositories.ok
    ? new GitProviderError({
        provider: "bitbucket",
        status: 401,
        message:
          "Bitbucket did not recognise the token as a user, a workspace or a repository member",
      })
    : repositories.failure;
}

function workspacePrincipal(json: unknown): ProviderPrincipal {
  const workspace = BitbucketWorkspaceSchema.parse(json);
  return {
    externalAccountId: workspace.uuid,
    login: workspace.slug,
    avatarUrl: workspace.links?.avatar?.href ?? null,
  };
}

async function tryJson(
  url: string,
  token: string,
): Promise<
  { ok: true; json: unknown } | { ok: false; failure: GitProviderError }
> {
  const res = await bitbucketFetch(url, token);
  if (!res.ok) return { ok: false, failure: await bitbucketFailure(res) };
  return { ok: true, json: await bitbucketJson(res, "principal") };
}

export class BitbucketProviderClient implements GitProviderClient {
  readonly kind = "bitbucket" as const;
  readonly host: string;
  private readonly tokenSource: TokenSource;

  constructor(params: { host: string; tokenSource: TokenSource }) {
    assertBitbucketCloud(params.host);
    this.host = BITBUCKET_HOST;
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
        provider: "bitbucket",
        status: 401,
        message: "Bitbucket account is not authenticated",
      });
    }
    return token;
  }

  async getRepo(repo: RepoRef): Promise<RepoSummary | null> {
    const res = await this.get(repositoryApiPath(repo));
    if (!res) return null;
    return mapBitbucketRepository(
      await bitbucketJson(res, "get_repo"),
      this.host,
    );
  }

  /**
   * Repositories the token can reach as a member, newest activity first.
   * Bitbucket filters server-side with its query language; `name ~ "x"` is
   * a case-insensitive substring match on the repository name.
   */
  async listRepos(
    opts: ListReposOptions = {},
  ): Promise<{ repositories: RepoSummary[]; hasMore: boolean }> {
    const params = new URLSearchParams({
      role: "member",
      sort: "-updated_on",
      pagelen: String(
        Math.min(MAX_PER_PAGE, Math.max(1, opts.perPage ?? DEFAULT_PER_PAGE)),
      ),
      page: String(Math.max(1, opts.page ?? 1)),
    });
    const query = opts.query?.trim();
    if (query) params.set("q", `name ~ ${bbqString(query)}`);
    const res = await this.get(`/repositories?${params}`);
    if (!res) return { repositories: [], hasMore: false };
    const page = await bitbucketJson<BitbucketPage<unknown>>(res, "list_repos");
    if (!Array.isArray(page.values)) {
      throw new GitProviderError({
        provider: "bitbucket",
        status: 502,
        message: "Bitbucket /repositories returned no values array",
      });
    }
    return {
      repositories: page.values.map((repository) =>
        mapBitbucketRepository(repository, this.host),
      ),
      hasMore: !!page.next,
    };
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
      `${repositoryApiPath(repo)}/src/${encodeURIComponent(branch)}/${encodeSrcPath(path)}`,
      { accept: "text/plain, */*" },
    );
    if (!res) return null;
    return res.text();
  }

  /**
   * The web host's download, not an API call. It authenticates the way `git`
   * does on that host (Basic with the `x-token-auth` user), so the bearer form
   * is tried first and the Basic form on a 401. Omitting `ref` downloads the
   * default branch, which costs one repository read to name.
   */
  async archiveTarball(
    repo: RepoRef,
    ref?: string,
  ): Promise<ReadableStream<Uint8Array> | null> {
    let at = ref;
    if (!at) {
      const summary = await this.getRepo(repo);
      if (!summary?.defaultBranch) return null;
      at = summary.defaultBranch;
    }
    const url = bitbucketArchiveUrl(repo, at);
    const init = {
      accept: "application/octet-stream, */*",
      timeoutMs: ARCHIVE_TIMEOUT_MS,
    };
    let res = await this.authedFetch(url, init);
    if (res.status === 401 || res.status === 403) {
      await res.body?.cancel().catch(() => {});
      const { token } = await this.accountToken();
      res = await bitbucketFetch(url, token, { ...init, basicAuth: true });
    }
    if (res.status === 404) {
      await res.body?.cancel().catch(() => {});
      return null;
    }
    if (!res.ok) throw await bitbucketFailure(res);
    return res.body;
  }

  /**
   * The user behind the token, when there is one. A workspace, project or
   * repository access token has no user and answers null, so callers fall
   * back to the bot identity — the same shape as a GitHub installation token.
   * The address needs the `email` scope; without it the noreply form stands in.
   */
  async identity(): Promise<GitIdentity | null> {
    const res = await this.authedFetch(`${BITBUCKET_API_BASE}/user`);
    if (res.status === 401 || res.status === 403) {
      await res.body?.cancel().catch(() => {});
      return null;
    }
    if (!res.ok) throw await bitbucketFailure(res);
    const user = BitbucketUserSchema.parse(
      await bitbucketJson(res, "identity"),
    );
    return {
      name: user.display_name || user.nickname,
      email:
        (await this.primaryEmail()) ??
        `${user.nickname}@users.noreply.${this.host}`,
    };
  }

  private async primaryEmail(): Promise<string | null> {
    const res = await this.authedFetch(
      `${BITBUCKET_API_BASE}/user/emails?pagelen=${MAX_PER_PAGE}`,
    );
    if (!res.ok) {
      await res.body?.cancel().catch(() => {});
      return null;
    }
    const page = await bitbucketJson<
      BitbucketPage<{
        email?: string | null;
        is_primary?: boolean | null;
        is_confirmed?: boolean | null;
      }>
    >(res, "user_emails").catch(() => null);
    const emails = page?.values ?? [];
    const pick =
      emails.find((e) => e.is_primary === true && e.is_confirmed !== false) ??
      emails.find((e) => e.is_confirmed !== false);
    return typeof pick?.email === "string" && pick.email ? pick.email : null;
  }

  private async get(
    pathAndQuery: string,
    init?: { accept?: string },
  ): Promise<Response | null> {
    const res = await this.authedFetch(
      `${BITBUCKET_API_BASE}${pathAndQuery}`,
      init,
    );
    if (res.status === 404) {
      await res.body?.cancel().catch(() => {});
      return null;
    }
    if (!res.ok) throw await bitbucketFailure(res);
    return res;
  }

  /**
   * One authenticated call. A 401 means the token died before `expiresAt`
   * said so (revoked, rotated): re-mint/refresh once and retry, matching the
   * other providers' behaviour for the same case.
   */
  private async authedFetch(
    url: string,
    init: { accept?: string; timeoutMs?: number } = {},
  ): Promise<Response> {
    const first = await this.accountToken();
    const res = await bitbucketFetch(url, first.token, init);
    if (res.status !== 401) return res;
    await res.body?.cancel().catch(() => {});
    const refreshed = await this.accountToken({ forceRefresh: true });
    return bitbucketFetch(url, refreshed.token, init);
  }
}

/**
 * A repository file path inside a `/src/{commit}/{path}` URL: each segment
 * encoded, the slashes kept, a leading slash dropped so `/README.md` and
 * `README.md` address the same file.
 */
export function encodeSrcPath(path: string): string {
  return path
    .replace(/^\/+/, "")
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
}
