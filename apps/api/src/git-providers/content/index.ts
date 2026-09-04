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
  parseRepoUrl,
  repoRefFromOwnerName,
  type RepoRef,
} from "@decocms/shared/git-providers";
import type { StudioContext } from "@/core/studio-context";
import { githubConnectionAccessToken } from "@/oauth/github-mint";
import { RECONNECT_ERROR } from "@/oauth/token-refresh";
import {
  type RepoCredential,
  repoCredentialForRepository,
  type RepoTarget,
  resolveRepoTarget,
  staticRepoCredential,
} from "../credentials";
import { GitProviderError, type GitTokenKind } from "../types";
import { GithubContentClient } from "./github";
import { GitlabContentClient } from "./gitlab";
import type { RepoContentClient } from "./types";

/**
 * Content client for a repository whose token the caller already holds — the
 * legacy connection paths, where the credential was minted before Studio knew
 * which repository it was for.
 */
function contentClientWithToken(
  repo: RepoRef,
  token: string,
  kind: GitTokenKind = "installation",
): RepoContentClient {
  return contentClientFor(staticRepoCredential(repo, token, kind));
}

function contentClientFor({
  ref,
  tokenSource,
}: RepoCredential): RepoContentClient {
  switch (ref.provider) {
    case "github":
      return new GithubContentClient({ repo: ref, tokenSource });
    case "gitlab":
      return new GitlabContentClient({ repo: ref, tokenSource });
  }
}

/**
 * Content client for a legacy `metadata.githubRepo` binding: the recorded
 * `mcp-github` connection (org-scoped) plus the repo-scoped installation token
 * it mints. Kept for orgs whose repos have no `repositories` row yet.
 */
async function contentClientForLegacyConnection(
  ctx: StudioContext,
  organizationId: string,
  ref: RepoRef,
  connectionId: string | null,
): Promise<RepoContentClient> {
  const missing = new GitProviderError({
    provider: ref.provider,
    status: 401,
    message:
      ref.provider === "github"
        ? "Project's GitHub connection is missing — reconnect GitHub"
        : `${ref.path} is not connected to this organization — link it in Settings → Repositories`,
  });
  if (!connectionId || ref.provider !== "github") throw missing;
  const connection = await ctx.storage.connections.findById(
    connectionId,
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
  return contentClientWithToken(ref, accessToken);
}

/**
 * Content client for a repository the caller names however it can — a
 * repository id, an identity, or a legacy connection. Shared by the decofile
 * routes, the sandbox-less `/git/*` compat handlers and the branch search so
 * credential resolution cannot drift between them.
 */
export async function contentClientForTarget(
  ctx: StudioContext,
  organizationId: string,
  target: RepoTarget,
): Promise<RepoContentClient> {
  const resolved = await resolveRepoTarget(ctx.storage, organizationId, target);
  if (!resolved) {
    throw new GitProviderError({
      provider: "github",
      status: 404,
      message:
        "No repository for this project — link one in Settings → Repositories",
    });
  }
  if (resolved.repository && resolved.servable) {
    return contentClientFor(
      await repoCredentialForRepository(ctx, resolved.repository),
    );
  }
  return contentClientForLegacyConnection(
    ctx,
    organizationId,
    resolved.ref,
    target.connectionId ?? null,
  );
}

/** {@link contentClientForTarget} for a project's legacy `githubRepo` binding. */
export function contentClientForProjectRepo(
  ctx: StudioContext,
  organizationId: string,
  githubRepo: GithubRepo,
): Promise<RepoContentClient> {
  return contentClientForTarget(ctx, organizationId, {
    repositoryId: githubRepo.repositoryId,
    ref:
      parseRepoUrl(githubRepo.url) ??
      repoRefFromOwnerName(githubRepo.owner, githubRepo.name),
    connectionId: githubRepo.connectionId,
  });
}
