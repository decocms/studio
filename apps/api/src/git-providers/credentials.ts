/**
 * From an account row to a working provider client, and from a repository row
 * to a credentialed clone URL.
 *
 * `auth_kind` decides where the token comes from:
 * - `github_app`  → minted from Studio's GitHub App key per repository. When
 *   the deployment has no App configured the account is a backfilled legacy
 *   one and cannot be served here; callers fall back to the `mcp-github` path.
 * - `oauth` / `token` → the grant in `git_provider_account_credentials`,
 *   refreshed through the same helpers `downstream_tokens` use.
 */

import type { Kysely } from "kysely";
import { cloneUrlFor, type RepoRef } from "@decocms/shared/git-providers";
import type { CredentialVault } from "@/encryption/credential-vault";
import {
  canRefresh,
  getValidDownstreamAccessToken,
  type OAuthGrantStore,
} from "@/oauth/token-refresh";
import { DECOBOT_GIT_IDENTITY } from "@/shared/git-bot-identity";
import {
  GitProviderAccountStorage,
  type GitProviderAccountRecord,
} from "@/storage/git-provider-accounts";
import { GitProviderAccountCredentialStorage } from "@/storage/git-provider-account-credentials";
import {
  type RepositoryRecord,
  RepositoryStorage,
  repoRefOf,
} from "@/storage/repositories";
import type { Database } from "@/storage/types";
import { getGithubAppAuth } from "./github/app-auth";
import { GithubProviderClient } from "./github/client";
import { GitlabProviderClient } from "./gitlab/client";
import {
  type GitProviderClient,
  GitProviderError,
  type GitTokenKind,
  type TokenOptions,
  type TokenSource,
} from "./types";

export interface GitProviderDeps {
  db: Kysely<Database>;
  vault: CredentialVault;
}

/**
 * A token source over a stored grant.
 *
 * `forceRefresh` is honoured only for a grant that can actually be refreshed.
 * A personal or project access token has no refresh token and no expiry: for
 * it, "force" would send `getValidDownstreamAccessToken` down its
 * `expired_without_refresh` branch and yield null — which is how a caller that
 * always asks for a fresh credential (SANDBOX_START, before baking one into a
 * clone URL) would fail every long-lived token.
 */
function grantTokenSource(
  store: OAuthGrantStore,
  grantKey: string,
  kind: GitTokenKind,
): TokenSource {
  return {
    kind,
    async get(opts?: TokenOptions) {
      const stored = opts?.forceRefresh ? await store.get(grantKey) : null;
      const result = await getValidDownstreamAccessToken({
        connectionId: grantKey,
        tokenStorage: store,
        bufferMs: opts?.bufferMs,
        force:
          opts?.forceRefresh === true && stored !== null && canRefresh(stored),
      });
      if (!result.accessToken) return null;
      return { token: result.accessToken, kind, expiresAt: null };
    },
  };
}

/** Stored grants are OAuth or a long-lived token; installations never reach here. */
function grantKind(
  authKind: GitProviderAccountRecord["authKind"],
): GitTokenKind {
  return authKind === "token" ? "token" : "oauth";
}

/**
 * Whether Studio itself can produce credentials for this account. False only
 * for a backfilled GitHub App account on a deployment without the App keys —
 * those still clone through their legacy `mcp-github` connection.
 */
export function accountIsServable(account: GitProviderAccountRecord): boolean {
  if (account.status !== "active") return false;
  if (account.type === "github" && account.authKind === "github_app") {
    return getGithubAppAuth() !== null && account.installationId !== null;
  }
  return true;
}

export function clientForAccount(
  deps: GitProviderDeps,
  account: GitProviderAccountRecord,
): GitProviderClient {
  const credentials = new GitProviderAccountCredentialStorage(
    deps.db,
    deps.vault,
  );
  switch (account.type) {
    case "github": {
      if (account.authKind === "github_app") {
        const appAuth = getGithubAppAuth();
        if (!appAuth || account.installationId === null) {
          throw new GitProviderError({
            provider: "github",
            status: 503,
            message:
              "GitHub App credentials are not configured on this deployment",
          });
        }
        return new GithubProviderClient({
          host: account.host,
          installationId: account.installationId,
          appAuth,
        });
      }
      return new GithubProviderClient({
        host: account.host,
        tokenSource: grantTokenSource(
          credentials,
          account.id,
          grantKind(account.authKind),
        ),
      });
    }
    case "gitlab":
      return new GitlabProviderClient({
        host: account.host,
        tokenSource: grantTokenSource(
          credentials,
          account.id,
          grantKind(account.authKind),
        ),
      });
  }
}

/** A repository plus a token source that can read and push it. */
export interface RepoCredential {
  ref: RepoRef;
  tokenSource: TokenSource;
}

/** The token kind an account's stored credential produces, before minting it. */
function tokenKindOf(account: GitProviderAccountRecord): GitTokenKind {
  if (account.authKind === "github_app") return "installation";
  return grantKind(account.authKind);
}

/**
 * A credential over an already-minted token — the legacy connection paths,
 * where the token was produced before Studio knew which repository it was for.
 */
export function staticRepoCredential(
  ref: RepoRef,
  token: string,
  kind: GitTokenKind = "installation",
): RepoCredential {
  return {
    ref,
    tokenSource: {
      kind,
      get: () => Promise.resolve({ token, kind, expiresAt: null }),
    },
  };
}

/**
 * The credential for a first-class repository row, through its git provider
 * account. Throws `GitProviderError` when the row is anonymous or its account
 * is gone — every provider API call Studio makes for a repository is
 * authenticated, even for a public one.
 *
 * Shared by every client factory (contents, change requests) so credential
 * resolution cannot drift between them.
 */
export async function repoCredentialForRepository(
  deps: GitProviderDeps,
  repository: RepositoryRecord,
): Promise<RepoCredential> {
  const ref = repoRefOf(repository);
  if (!repository.accountId) {
    throw new GitProviderError({
      provider: repository.provider,
      status: 401,
      message: `${repository.path} is linked without an account; link it again to read and write it`,
    });
  }
  const account = await new GitProviderAccountStorage(deps.db).getUnscoped(
    repository.accountId,
  );
  if (!account || account.organizationId !== repository.organizationId) {
    throw new GitProviderError({
      provider: repository.provider,
      status: 404,
      message: `The account backing ${repository.path} no longer exists. Link the repository again.`,
    });
  }
  const client = clientForAccount(deps, account);
  const kind = tokenKindOf(account);
  return {
    ref,
    tokenSource: { kind, get: (opts) => client.tokenForRepo(ref, opts) },
  };
}

export interface RepoCloneInfo {
  cloneUrl: string;
  gitUserName: string;
  gitUserEmail: string;
}

/**
 * Credentialed clone URL + commit identity for a repository row. Anonymous
 * (no account) repositories get a plain HTTPS URL and the bot identity.
 * Throws `GitProviderError` when the account cannot produce a token.
 */
export async function cloneInfoForRepository(
  deps: GitProviderDeps,
  repository: RepositoryRecord,
  opts?: TokenOptions,
): Promise<RepoCloneInfo> {
  const ref = repoRefOf(repository);
  if (!repository.accountId) return anonymousCloneInfo(ref);

  const account = await new GitProviderAccountStorage(deps.db).getUnscoped(
    repository.accountId,
  );
  if (!account || account.organizationId !== repository.organizationId) {
    throw new GitProviderError({
      provider: repository.provider,
      status: 404,
      message: `The account backing ${repository.path} no longer exists. Link the repository again.`,
    });
  }
  const client = clientForAccount(deps, account);
  const token = await client.tokenForRepo(ref, opts);
  const identity =
    token.kind === "installation"
      ? null
      : await client.identity().catch(() => null);
  return {
    cloneUrl: cloneUrlFor(ref, token.token),
    gitUserName: identity?.name ?? DECOBOT_GIT_IDENTITY.name,
    gitUserEmail: identity?.email ?? DECOBOT_GIT_IDENTITY.email,
  };
}

function anonymousCloneInfo(ref: RepoRef): RepoCloneInfo {
  return {
    cloneUrl: cloneUrlFor(ref),
    gitUserName: DECOBOT_GIT_IDENTITY.name,
    gitUserEmail: DECOBOT_GIT_IDENTITY.email,
  };
}

/** The storage ports these lookups need — satisfied by `ctx.storage`. */
/**
 * How a caller names the repository it wants a client for.
 *
 * Three fields because records were written at three different times: the
 * repository id is what everything records now, the identity is what older
 * rows carry, and the connection is the pre-repository world. Every client
 * factory takes this shape so the ladder cannot differ between them.
 */
export interface RepoTarget {
  /** The first-class repository row. Wins over `ref`. */
  repositoryId?: string | null;
  /** Identity, for records written before the id was captured. */
  ref?: RepoRef | null;
  /** The legacy `mcp-github` connection, when the record carries one. */
  connectionId?: string | null;
}

export interface ResolvedRepoTarget {
  ref: RepoRef;
  /** The org's repository row for it, when there is one. */
  repository: RepositoryRecord | null;
  /** Whether that row's account is one Studio can mint credentials from. */
  servable: boolean;
}

/**
 * Resolve a target to a concrete repository, without minting anything.
 *
 * Null when the target names nothing this org has: neither an id it owns nor
 * an identity — which is the caller's cue to report "connect this repository"
 * rather than to guess. A row that exists but whose account Studio cannot
 * serve still resolves, with `servable: false`, so the caller can fall back to
 * the legacy connection path for it.
 */
export async function resolveRepoTarget(
  storage: GitProviderStoragePorts,
  organizationId: string,
  target: RepoTarget,
): Promise<ResolvedRepoTarget | null> {
  const repository = target.repositoryId
    ? await storage.repositories.get(target.repositoryId, organizationId)
    : target.ref
      ? await storage.repositories.findByRef(organizationId, target.ref)
      : null;
  const ref = repository ? repoRefOf(repository) : (target.ref ?? null);
  if (!ref) return null;
  return {
    ref,
    repository,
    servable: repository
      ? await repositoryUsesStudioCredentials(storage, repository)
      : false,
  };
}

export interface GitProviderStoragePorts {
  repositories: Pick<RepositoryStorage, "get" | "findByRef">;
  gitProviderAccounts: Pick<GitProviderAccountStorage, "getUnscoped">;
}

/**
 * True when `repository` should be cloned through Studio-owned credentials
 * rather than the legacy `mcp-github` connection path: it has an account and
 * Studio can serve that account.
 */
export async function repositoryUsesStudioCredentials(
  storage: Pick<GitProviderStoragePorts, "gitProviderAccounts">,
  repository: RepositoryRecord,
): Promise<boolean> {
  if (!repository.accountId) return false;
  const account = await storage.gitProviderAccounts.getUnscoped(
    repository.accountId,
  );
  return account !== null && accountIsServable(account);
}
