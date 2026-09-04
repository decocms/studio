/**
 * Git provider client contract.
 *
 * One implementation per `GitProviderKind` (github, gitlab). The account row's
 * `type` picks the implementation (`registry.ts`); its `auth_kind` picks how
 * tokens are produced (`credentials.ts`). Nothing outside `git-providers/`
 * builds a provider URL, header or token — callers speak `RepoRef` and get
 * back neutral shapes.
 *
 * Studio talks to the providers' REST APIs directly with `fetch`. There is no
 * MCP round-trip in this path by design: Studio owns the credentials and the
 * refresh flow, so the extra hop bought nothing.
 */

import type { GitProviderKind, RepoRef } from "@decocms/shared/git-providers";

export type RepoVisibility = "public" | "private" | "internal";

/** Whether this deployment can run a provider's connect flow, and where. */
export interface GitProviderCapability {
  configured: boolean;
  /**
   * Hosts with a registration. Empty when unconfigured; a host absent from a
   * configured provider's list connects with a token instead.
   */
  hosts: string[];
}

export interface RepoSummary {
  ref: RepoRef;
  /** Provider repository/project id, as a string (GitLab ids are numeric, GitHub's too). */
  externalId: string;
  defaultBranch: string | null;
  webUrl: string;
  visibility: RepoVisibility;
  description: string | null;
  /** ISO timestamp of the provider's "last activity/pushed" signal, for sorting. */
  updatedAt: string | null;
}

/** Author identity for commits made on behalf of the account. */
export interface GitIdentity {
  name: string;
  email: string;
}

/** The provider-side principal a token authenticates as. */
export interface ProviderPrincipal {
  externalAccountId: string;
  login: string;
  avatarUrl: string | null;
}

export type GitTokenKind = "installation" | "oauth" | "token";

export interface GitAccessToken {
  token: string;
  kind: GitTokenKind;
  expiresAt: Date | null;
}

export interface TokenOptions {
  /** Refresh/re-mint when less than this many ms of life remain. */
  bufferMs?: number;
  /** The upstream just rejected the token: skip the freshness check. */
  forceRefresh?: boolean;
}

export interface ListReposOptions {
  /** Substring / search query over repository names. */
  query?: string;
  page?: number;
  perPage?: number;
}

export interface GitProviderClient {
  readonly kind: GitProviderKind;
  readonly host: string;

  /**
   * A token that can read and push `repo`. Repo-scoped where the provider
   * allows it (GitHub App installation tokens restricted to one repository);
   * otherwise the account's token.
   */
  tokenForRepo(repo: RepoRef, opts?: TokenOptions): Promise<GitAccessToken>;

  /** A token for account-wide reads: listing and searching repositories. */
  accountToken(opts?: TokenOptions): Promise<GitAccessToken>;

  /** Repository facts, or null when the provider answers 404. */
  getRepo(repo: RepoRef): Promise<RepoSummary | null>;

  /** Repositories the account can reach, optionally filtered by `query`. */
  listRepos(opts?: ListReposOptions): Promise<RepoSummary[]>;

  /** Raw file contents at `path` on `ref` (default branch when omitted), or null on 404. */
  readFile(repo: RepoRef, path: string, ref?: string): Promise<string | null>;

  /**
   * A gzipped tar of the whole repository at `ref` (default branch when
   * omitted), or null when the provider answers 404. The stream is the
   * response body — the caller owns it and must consume or cancel it.
   *
   * Providers disagree on the archive's single top-level directory name
   * (`owner-repo-sha/` vs `project-ref-sha/`); consumers strip one leading
   * segment rather than reconstructing either convention.
   */
  archiveTarball(
    repo: RepoRef,
    ref?: string,
  ): Promise<ReadableStream<Uint8Array> | null>;

  /**
   * Commit author identity for the account's token, or null when the token
   * does not map to a user (GitHub App installation tokens). Callers fall back
   * to a bot identity.
   */
  identity(): Promise<GitIdentity | null>;
}

/**
 * Failure from a provider API call. `status` is the HTTP status (0 for
 * network/timeout), `retryAfterMs` is set when the provider signalled a rate
 * limit with a wait hint.
 */
export class GitProviderError extends Error {
  readonly provider: GitProviderKind;
  readonly status: number;
  readonly retryAfterMs: number | null;
  constructor(params: {
    provider: GitProviderKind;
    status: number;
    message: string;
    retryAfterMs?: number | null;
    cause?: unknown;
  }) {
    super(params.message, { cause: params.cause });
    this.name = "GitProviderError";
    this.provider = params.provider;
    this.status = params.status;
    this.retryAfterMs = params.retryAfterMs ?? null;
  }
  get isRateLimited(): boolean {
    return this.status === 429 || this.retryAfterMs !== null;
  }
  get isAuthFailure(): boolean {
    return this.status === 401 || this.status === 403;
  }
}

/**
 * Source of a bearer token for a client that does not mint its own (OAuth
 * grants, personal/project access tokens). `get` returns null when the grant
 * is missing or could not be refreshed — the caller decides how to surface
 * "reconnect".
 */
export interface TokenSource {
  readonly kind: GitTokenKind;
  get(opts?: TokenOptions): Promise<GitAccessToken | null>;
}
