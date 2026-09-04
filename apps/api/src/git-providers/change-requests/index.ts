/**
 * From a repository to a `ChangeRequestClient`.
 *
 * Three credential paths, tried in that order — the same ladder every other
 * git-provider factory walks (`resolveRepoTarget` is the shared half):
 * - the `repositories` row named on the caller's record, when its git provider
 *   account is one Studio can serve;
 * - the row that matches the repository's identity, for records written before
 *   the id was captured;
 * - the legacy `mcp-github` connection (`legacy.ts`), for orgs not migrated
 *   yet. GitHub only — GitLab never had one.
 *
 * `null` rather than a throw when no path works: the task board reports "no
 * credential for this repository" on the card, and a throw there would take
 * down a read that has plenty else to show. A credential that EXISTS but
 * cannot mint (a revoked grant) still throws — that is a real failure, and
 * reading it as "no repository" is how a broken card looks merely empty.
 */

import type { RepoRef } from "@decocms/shared/git-providers";
import type { StudioContext } from "@/core/studio-context";
import { githubConnectionAccessToken } from "@/oauth/github-mint";
import {
  type RepoCredential,
  repoCredentialForRepository,
  type RepoTarget,
  resolveRepoTarget,
  staticRepoCredential,
} from "../credentials";
import { GithubChangeRequestClient } from "./github";
import { GitlabChangeRequestClient } from "./gitlab";
import { resolveLegacyGithubConnection } from "./legacy";
export * from "./types";
import type { ChangeRequestClient } from "./types";

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
 * Where a change request's repository was recorded. `repo` is required here
 * because a linked row always has its URL, and therefore its identity — which
 * is what lets the board answer without a repository row at all.
 */
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
 * A client for a repository the caller names however it can — a repository
 * id, an identity, or a legacy connection. Null when this org has none of
 * those; see the module note.
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
  const connection = await resolveLegacyGithubConnection(
    ctx,
    organizationId,
    resolved.ref,
    target.connectionId ?? null,
  );
  if (!connection) return null;
  const accessToken = await githubConnectionAccessToken(ctx, connection);
  if (!accessToken) return null;
  return changeRequestClientFor(
    staticRepoCredential(resolved.ref, accessToken),
  );
}
