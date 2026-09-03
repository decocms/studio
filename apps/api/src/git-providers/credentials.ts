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
import { readGithubAppConfig } from "./env";
import { GithubAppAuth } from "./github/app-auth";
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

let appAuthSingleton: GithubAppAuth | null | undefined;

/** Process-wide GitHub App signer (its token cache lives inside); null when unconfigured. */
export function getGithubAppAuth(): GithubAppAuth | null {
  if (appAuthSingleton === undefined) {
    const config = readGithubAppConfig();
    appAuthSingleton = config ? new GithubAppAuth(config) : null;
  }
  return appAuthSingleton;
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
export interface GitProviderStoragePorts {
  repositories: Pick<RepositoryStorage, "get" | "findByRef">;
  gitProviderAccounts: Pick<GitProviderAccountStorage, "getUnscoped">;
}

/**
 * The repository row a legacy `metadata.githubRepo` binding refers to, if the
 * org has one — by explicit `repositoryId` when the binding carries it, else by
 * identity (`github.com/owner/name`). Null keeps the caller on the legacy path.
 */
export async function findRepositoryForLegacyBinding(
  storage: Pick<GitProviderStoragePorts, "repositories">,
  organizationId: string,
  binding: { owner: string; name: string; repositoryId?: string | null },
): Promise<RepositoryRecord | null> {
  if (binding.repositoryId) {
    const byId = await storage.repositories.get(
      binding.repositoryId,
      organizationId,
    );
    if (byId) return byId;
  }
  return storage.repositories.findByRef(organizationId, {
    host: "github.com",
    path: `${binding.owner}/${binding.name}`,
  });
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
