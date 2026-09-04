/**
 * The composition root: from a repository to a client that can act on it.
 *
 * This is the ONE module that knows both providers exist. Everything above it
 * speaks `RepoRef` and gets back an interface; everything below it is one
 * provider's own vocabulary, sealed in `github/` or `gitlab/`. The `switch`
 * here is a registry, not knowledge — adding a provider is a case and a
 * directory.
 *
 * Every factory walks the same credential ladder (`resolveRepoTarget`):
 * - the `repositories` row named on the caller's record, when its git provider
 *   account is one Studio can serve;
 * - the row matching the repository's identity, for records written before the
 *   id was captured;
 * - the legacy `mcp-github` connection, for orgs not migrated yet. GitHub
 *   only — GitLab never had one.
 *
 * The two capability factories differ deliberately in what they do when no
 * path works. A content client THROWS: every caller is about to read or write
 * a file and has nothing to show without one. A change-request client answers
 * NULL: the task board renders a card that has plenty else on it, and a throw
 * there would take down the whole read.
 */

import type { GithubRepo } from "@decocms/shared/sdk/types";
import {
  parseRepoUrl,
  type RepoRef,
  repoRefFromOwnerName,
} from "@decocms/shared/git-providers";
import type { GitProviderKind } from "@decocms/shared/git-providers";
import type { StudioContext } from "@/core/studio-context";
import { githubConnectionAccessToken } from "@/oauth/github-mint";
import { RECONNECT_ERROR } from "@/oauth/token-refresh";
import type { ChangeRequestClient } from "./change-requests";
import type { RepoContentClient } from "./content";
import {
  type RepoCredential,
  repoCredentialForRepository,
  type RepoTarget,
  resolveRepoTarget,
  staticRepoCredential,
} from "./credentials";
import { GithubChangeRequestClient } from "./github/change-requests";
import { GithubContentClient } from "./github/content";
import { resolveLegacyGithubConnection } from "./github/legacy-connection";
import { GitlabChangeRequestClient } from "./gitlab/change-requests";
import { gitlabCurrentUser } from "./gitlab/client";
import { GitlabContentClient } from "./gitlab/content";
import {
  GitProviderError,
  type GitTokenKind,
  type ProviderPrincipal,
} from "./types";

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

function changeRequestClientFor({
  ref,
  tokenSource,
}: RepoCredential): ChangeRequestClient {
  switch (ref.provider) {
    case "github":
      return new GithubChangeRequestClient({ repo: ref, tokenSource });
    case "gitlab":
      return new GitlabChangeRequestClient({ repo: ref, tokenSource });
  }
}

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

/**
 * The legacy `mcp-github` token for `ref`, or null when this org has no
 * connection that can reach it. Shared by both factories so the one remaining
 * pre-repository credential path cannot behave differently per capability.
 */
async function legacyGithubToken(
  ctx: StudioContext,
  organizationId: string,
  ref: RepoRef,
  connectionId: string | null,
): Promise<string | null> {
  const connection = await resolveLegacyGithubConnection(
    ctx,
    organizationId,
    ref,
    connectionId,
  );
  if (!connection) return null;
  return githubConnectionAccessToken(ctx, connection);
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
  const token = await legacyGithubToken(
    ctx,
    organizationId,
    resolved.ref,
    target.connectionId ?? null,
  );
  if (!token) {
    throw new GitProviderError({
      provider: resolved.ref.provider,
      status: 401,
      message:
        resolved.ref.provider === "github"
          ? RECONNECT_ERROR
          : `${resolved.ref.path} is not connected to this organization — link it in Settings → Repositories`,
    });
  }
  return contentClientWithToken(resolved.ref, token);
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

/** Where a change request's repository was recorded, however completely. */
export interface ChangeRequestOrigin {
  repo: RepoRef;
  repositoryId?: string | null;
  connectionId?: string | null;
}

/** A client for `origin`'s repository, or null — see the module note. */
export function changeRequestClientForOrigin(
  ctx: StudioContext,
  organizationId: string,
  origin: ChangeRequestOrigin,
): Promise<ChangeRequestClient | null> {
  return changeRequestClientForTarget(ctx, organizationId, {
    repositoryId: origin.repositoryId,
    ref: origin.repo,
    connectionId: origin.connectionId,
  });
}

/**
 * A client for a repository the caller names however it can. Null when this
 * org has none of those paths; a credential that EXISTS but cannot mint (a
 * revoked grant) still throws — that is a real failure, and reading it as "no
 * repository" is how a broken card looks merely empty.
 */
export async function changeRequestClientForTarget(
  ctx: StudioContext,
  organizationId: string,
  target: RepoTarget,
): Promise<ChangeRequestClient | null> {
  const resolved = await resolveRepoTarget(ctx.storage, organizationId, target);
  if (!resolved) return null;
  if (resolved.repository && resolved.servable) {
    return changeRequestClientFor(
      await repoCredentialForRepository(ctx, resolved.repository),
    );
  }
  const token = await legacyGithubToken(
    ctx,
    organizationId,
    resolved.ref,
    target.connectionId ?? null,
  );
  return token
    ? changeRequestClientFor(staticRepoCredential(resolved.ref, token))
    : null;
}

/**
 * Who a raw access token authenticates as — the connect-by-token flow, which
 * has to name the account before it can store the credential under it.
 *
 * GitHub is refused rather than merely unimplemented: its accounts connect
 * through the App so Studio can mint a token scoped to ONE repository, and a
 * user PAT would silently widen every repository to that user's blanket
 * access. That is a policy about what each provider offers, so it lives with
 * the registry rather than in a tool.
 */
export function principalForToken(
  provider: GitProviderKind,
  host: string,
  token: string,
): Promise<ProviderPrincipal> {
  switch (provider) {
    case "gitlab":
      return gitlabCurrentUser(host, token);
    case "github":
      throw new GitProviderError({
        provider,
        status: 400,
        message:
          "GitHub accounts connect through the GitHub App; tokens are accepted for GitLab only",
      });
  }
}
