import type { GithubRepo } from "@decocms/shared/sdk/types";
import { getRepoScope } from "@decocms/shared/github-repo-scope";
import type { StudioContext } from "@/core/studio-context";
import { ensureRepoScopedToken } from "@/oauth/github-mint";
import {
  getValidDownstreamAccessToken,
  RECONNECT_ERROR,
} from "@/oauth/token-refresh";
import { DownstreamTokenStorage } from "@/storage/downstream-token";
import { createGitDataClient, GitHubApiError } from "./github-git-data";
import type { GitDataClient } from "./github-git-data";

/**
 * Git Data client for a project's linked repo: resolves the recorded
 * connection (org-scoped) and mints/reuses the repo-scoped installation
 * token. Shared by the decofile routes and the sandbox-less `/git/*` compat
 * handlers so credential resolution cannot drift between them.
 */
export async function gitDataClientForRepo(
  ctx: StudioContext,
  organizationId: string,
  githubRepo: GithubRepo,
): Promise<GitDataClient> {
  if (!githubRepo.connectionId) {
    throw new GitHubApiError(
      401,
      "AUTH",
      "connection",
      "Project's GitHub connection is missing — reconnect GitHub",
    );
  }
  const connection = await ctx.storage.connections.findById(
    githubRepo.connectionId,
    organizationId,
  );
  if (!connection) {
    throw new GitHubApiError(
      401,
      "AUTH",
      "connection",
      "Project's GitHub connection is missing — reconnect GitHub",
    );
  }
  const accessToken = await repoAccessToken(ctx, connection);
  if (!accessToken) {
    throw new GitHubApiError(401, "AUTH", "connection", RECONNECT_ERROR);
  }
  return createGitDataClient({
    owner: githubRepo.owner,
    repo: githubRepo.name,
    accessToken,
  });
}

/**
 * GitHub credential for a repo-scoped connection, forked the same way as the
 * MCP proxy's `outbound/headers`: legacy children re-mint their ~1h `ghs_`
 * token, current ones read the refreshable grant in `downstream_tokens`.
 * `ensureRepoScopedToken` alone rejects the latter before consulting it.
 */
async function repoAccessToken(
  ctx: StudioContext,
  connection: Parameters<typeof ensureRepoScopedToken>[1],
): Promise<string | null> {
  if (getRepoScope(connection)?.sourceConnectionId) {
    return ensureRepoScopedToken(ctx, connection);
  }
  const tokenResult = await getValidDownstreamAccessToken({
    connectionId: connection.id,
    connectionUrl: connection.connection_url,
    tokenStorage: new DownstreamTokenStorage(ctx.db, ctx.vault),
  });
  return tokenResult.accessToken;
}
