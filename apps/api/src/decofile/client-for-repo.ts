import type { GithubRepo } from "@decocms/shared/sdk/types";
import type { StudioContext } from "@/core/studio-context";
import { ensureRepoScopedToken } from "@/oauth/github-mint";
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
  const accessToken = await ensureRepoScopedToken(ctx, connection);
  return createGitDataClient({
    owner: githubRepo.owner,
    repo: githubRepo.name,
    accessToken,
  });
}
