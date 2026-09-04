/**
 * The repos an org can hand an agent, across BOTH models.
 *
 * Three places answer "which repo does this run work in" — `load_repo` (the
 * Decopilot built-in), `TASK_ADD_REPO` (mid-run clone into a task pod), and the
 * dispatch-time pick in `claude-code-task-run.ts` — and they are one feature, so
 * they read one list. Before this they each walked the org's `mcp-github`
 * connections directly, which made a first-class repository (any GitLab one, and
 * every GitHub one linked through the new model) invisible to an agent even
 * though Studio could mint for it.
 *
 * Nothing here names a provider: the legacy half arrives already in `RepoRef`
 * form from `github/legacy-connection.ts`, which is the only module that knows
 * a connection can stand for a repository.
 *
 * The unit every consumer passes around is a `RepoChoice`: an opaque id plus the
 * `owner`/`name`/`webUrl` the later consumers (thread metadata, PR extraction,
 * the git sync) already read.
 */

import type { StudioContext } from "@/core/studio-context";
import type { RepositoryRecord } from "@/storage/repositories";
import {
  type GitProviderKind,
  repoIdentityKey,
  repoWebUrl,
  splitOwnerName,
} from "@decocms/shared/git-providers";
import { repositoryUsesStudioCredentials } from "./credentials";
import {
  type LegacyRepoChoice,
  listLegacyRepoChoices,
} from "./github/legacy-connection";

/**
 * One repository the agent may clone, from either model.
 *
 * `id` is what the agent passes back and is opaque to it: a repository id or,
 * for an org still on the legacy path, a connection id. It is also the sandbox
 * isolation key, so two repos never share a checkout. `owner`/`name` stay
 * because every later consumer (thread metadata, PR extraction, the git sync)
 * still reads them; for a GitLab project nested in subgroups `owner` is the
 * whole namespace.
 */
export interface RepoChoice {
  id: string;
  owner: string;
  name: string;
  label: string;
  webUrl: string;
  /** Chooses the CLI and the wording an agent's prompt has to use. */
  provider: GitProviderKind;
  repository: RepositoryRecord | null;
  connectionId: string | null;
  installationId: number | undefined;
}

/**
 * The clonable set an org is offered, from both models.
 *
 * First-class repositories come first and shadow a legacy connection for the
 * same repo, so an org part-way through the migration is offered each
 * repository once — through the credential Studio can actually mint today.
 * Two legacy connections for one repo collapse the same way. Pure, and exported
 * for its test.
 */
export function mergeRepoChoices(
  repositories: RepositoryRecord[],
  legacy: LegacyRepoChoice[],
): RepoChoice[] {
  const out: RepoChoice[] = [];
  const seen = new Set<string>();

  for (const repository of repositories) {
    const { owner, name } = splitOwnerName(repository);
    seen.add(repoIdentityKey(repository));
    out.push({
      id: repository.id,
      owner,
      name,
      label: `${repository.path} (${repository.host})`,
      webUrl: repository.webUrl,
      provider: repository.provider,
      repository,
      connectionId: null,
      installationId: undefined,
    });
  }

  for (const entry of legacy) {
    if (seen.has(repoIdentityKey(entry.ref))) continue;
    seen.add(repoIdentityKey(entry.ref));
    const { owner, name } = splitOwnerName(entry.ref);
    out.push({
      id: entry.connectionId,
      owner,
      name,
      label: `${entry.ref.path} (${entry.ref.host})`,
      webUrl: repoWebUrl(entry.ref),
      provider: entry.ref.provider,
      repository: null,
      connectionId: entry.connectionId,
      installationId: entry.installationId,
    });
  }
  return out;
}

/** The org's clonable repos, looked up fresh each call (one can be linked
 *  while a run is in flight). */
export async function listOrgRepoChoices(
  ctx: StudioContext,
  orgId: string,
): Promise<RepoChoice[]> {
  const linked = await ctx.storage.repositories.listByOrg(orgId);
  const servable: RepositoryRecord[] = [];
  for (const repository of linked) {
    if (await repositoryUsesStudioCredentials(ctx.storage, repository)) {
      servable.push(repository);
    }
  }
  return mergeRepoChoices(servable, await listLegacyRepoChoices(ctx, orgId));
}
