/**
 * From a repository (or a legacy `metadata.githubRepo` binding) to a
 * `RepoContentClient`.
 *
 * Two credential paths, the same two the clone path has:
 * - a first-class `repositories` row whose git provider account Studio can
 *   serve — the provider client mints the repo token (`clientForAccount`), and
 *   the row's `provider` picks the implementation;
 * - the legacy `mcp-github` connection recorded on the binding, for orgs that
 *   have not been migrated to a repository row yet.
 *
 * A client instance is meant to live for ONE request: its default-branch memo
 * and commit→tree memo assume no ref moves under it.
 */

import type { GithubRepo } from "@decocms/shared/sdk/types";
import {
  repoRefFromOwnerName,
  type RepoRef,
} from "@decocms/shared/git-providers";
import type { StudioContext } from "@/core/studio-context";
import { githubConnectionAccessToken } from "@/oauth/github-mint";
import { RECONNECT_ERROR } from "@/oauth/token-refresh";
import { GitProviderAccountStorage } from "@/storage/git-provider-accounts";
import { type RepositoryRecord, repoRefOf } from "@/storage/repositories";
import {
  clientForAccount,
  findRepositoryForLegacyBinding,
  type GitProviderDeps,
  repositoryUsesStudioCredentials,
} from "../credentials";
import {
  type GitProviderClient,
  GitProviderError,
  type GitTokenKind,
  type TokenSource,
} from "../types";
import { GithubContentClient } from "./github";
import { GitlabContentClient } from "./gitlab";
import type { RepoContentClient } from "./types";

/** The token kind an account's stored credential produces, before minting it. */
function tokenKindOf(account: { authKind: string }): GitTokenKind {
  if (account.authKind === "github_app") return "installation";
  return account.authKind === "token" ? "token" : "oauth";
}

/** A token source over one repository's push/read credential. */
function repoTokenSource(
  client: GitProviderClient,
  repo: RepoRef,
  kind: GitTokenKind,
): TokenSource {
  return { kind, get: (opts) => client.tokenForRepo(repo, opts) };
}

/** A token source over an already-minted token — the legacy connection path. */
function staticTokenSource(token: string, kind: GitTokenKind): TokenSource {
  return { kind, get: () => Promise.resolve({ token, kind, expiresAt: null }) };
}

/**
 * Content client for a repository whose token the caller already holds — the
 * legacy connection paths, where the credential was minted before Studio knew
 * which repository it was for.
 */
export function contentClientWithToken(
  repo: RepoRef,
  token: string,
  kind: GitTokenKind = "installation",
): RepoContentClient {
  return contentClientFor(repo, staticTokenSource(token, kind));
}

function contentClientFor(
  repo: RepoRef,
  tokenSource: TokenSource,
): RepoContentClient {
  switch (repo.provider) {
    case "github":
      return new GithubContentClient({ repo, tokenSource });
    case "gitlab":
      return new GitlabContentClient({ repo, tokenSource });
  }
}

/**
 * Content client for a first-class repository row, credentialed through its
 * git provider account. Throws `GitProviderError` when the row is anonymous or
 * its account cannot produce a token — reading a repository's contents is
 * always authenticated here, even for a public one.
 */
async function contentClientForRepository(
  deps: GitProviderDeps,
  repository: RepositoryRecord,
): Promise<RepoContentClient> {
  const ref = repoRefOf(repository);
  if (!repository.accountId) {
    throw new GitProviderError({
      provider: repository.provider,
      status: 401,
      message: `${repository.path} is linked without an account; link it again to read and write its contents`,
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
  return contentClientFor(
    ref,
    repoTokenSource(client, ref, tokenKindOf(account)),
  );
}

/**
 * Content client for a legacy `metadata.githubRepo` binding: the recorded
 * `mcp-github` connection (org-scoped) plus the repo-scoped installation token
 * it mints. Kept for orgs whose repos have no `repositories` row yet.
 */
async function contentClientForLegacyConnection(
  ctx: StudioContext,
  organizationId: string,
  githubRepo: GithubRepo,
): Promise<RepoContentClient> {
  const missing = new GitProviderError({
    provider: "github",
    status: 401,
    message: "Project's GitHub connection is missing — reconnect GitHub",
  });
  if (!githubRepo.connectionId) throw missing;
  const connection = await ctx.storage.connections.findById(
    githubRepo.connectionId,
    organizationId,
  );
  if (!connection) throw missing;
  const accessToken = await githubConnectionAccessToken(ctx, connection);
  if (!accessToken) {
    throw new GitProviderError({
      provider: "github",
      status: 401,
      message: RECONNECT_ERROR,
    });
  }
  return contentClientWithToken(
    repoRefFromOwnerName(githubRepo.owner, githubRepo.name),
    accessToken,
  );
}

/**
 * Content client for a project's linked repo, taking whichever credential path
 * the org is on. Shared by the decofile routes and the sandbox-less `/git/*`
 * compat handlers so credential resolution cannot drift between them.
 */
export async function contentClientForProjectRepo(
  ctx: StudioContext,
  organizationId: string,
  githubRepo: GithubRepo,
): Promise<RepoContentClient> {
  const repository = await findRepositoryForLegacyBinding(
    ctx.storage,
    organizationId,
    githubRepo,
  );
  if (
    repository &&
    (await repositoryUsesStudioCredentials(ctx.storage, repository))
  ) {
    return contentClientForRepository(ctx, repository);
  }
  return contentClientForLegacyConnection(ctx, organizationId, githubRepo);
}
