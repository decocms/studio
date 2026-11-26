/**
 * The store's code through Studio's git providers: the site project's
 * repository, only when it is one THIS organization linked, read with the
 * provider account the organization connected for it.
 */

import type { StudioContext } from "@/core/studio-context";
import { insightsClientForRepository } from "@/git-providers";
import type { RepositoryRecord } from "@/storage/repositories";
import type { SiteProfile } from "../types.ts";
import {
  type CodeAccess,
  CodeGapError,
  type CodeView,
  noRepositoryGap,
  notLinkedGap,
  openRepoView,
  repoLabel,
  unusableGap,
} from "../verify/code-source.ts";
import { type RepoIdentity, repoIdentityOf } from "../verify/studio-repo.ts";
import { findLinkedRepository, repositoryUsability } from "./repo-usability.ts";

type RepoContext = Pick<StudioContext, "storage" | "db" | "vault">;

/** The organization's row for the identity: by its Studio id, else by provider, host and path. */
function linkedRepository(
  ctx: RepoContext,
  orgId: string,
  repo: RepoIdentity,
): Promise<RepositoryRecord | null> {
  return repo.repository_id
    ? ctx.storage.repositories.get(repo.repository_id, orgId)
    : findLinkedRepository(ctx.storage.repositories, orgId, repo);
}

async function openLinkedRepo(
  ctx: StudioContext,
  orgId: string,
  repo: RepoIdentity,
): Promise<CodeView> {
  const label = repoLabel(repo);
  const repository = await linkedRepository(ctx, orgId, repo);
  if (!repository) throw new CodeGapError(notLinkedGap(label));
  const usability = await repositoryUsability(ctx, repository);
  if (!usability.usable) {
    throw new CodeGapError(unusableGap(usability.reason, repo.provider, label));
  }
  return openRepoView(
    await insightsClientForRepository(ctx, repository),
    label,
  );
}

/** How this run reads the store's code; resolving the repository waits for `open`. */
export function codeAccessFor(
  ctx: StudioContext,
  orgId: string,
  profile: Pick<SiteProfile, "code_repo" | "sources"> | null,
): CodeAccess {
  const repo = repoIdentityOf(profile);
  if (!repo) return { kind: "gap", gap: noRepositoryGap() };
  return {
    kind: "ready",
    repo: repoLabel(repo),
    provider: repo.provider,
    open: () => openLinkedRepo(ctx, orgId, repo),
  };
}
