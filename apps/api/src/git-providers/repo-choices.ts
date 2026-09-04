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
 * The unit every consumer passes around is a `RepoChoice`: an opaque id plus the
 * `owner`/`name`/`webUrl` the later consumers (thread metadata, PR extraction,
 * the git sync) already read.
 */

import type { StudioContext } from "@/core/studio-context";
import { repositoryUsesStudioCredentials } from "@/git-providers/credentials";
import { selectLoadableRepos } from "@/harnesses/decopilot/built-in-tools/load-repo";
import type { RepositoryRecord } from "@/storage/repositories";
import { isOrgSharedConnection } from "@decocms/shared/github-repo-scope";
import { splitOwnerName } from "@decocms/shared/git-providers";

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
  repository: RepositoryRecord | null;
  connectionId: string | null;
  installationId: number | undefined;
}

/** The connection shape the legacy selection needs. */
type RepoConnection = {
  id: string;
  status: string;
  metadata: Record<string, unknown> | null;
};

/**
 * The org-shared `mcp-github` connections first, everything else after, order
 * otherwise preserved.
 *
 * Importing ONE repo routinely leaves two loadable connections behind — the
 * org-shared one and a per-agent one — and `mergeRepoChoices` keeps whichever it
 * sees first. The per-agent child is disposable (torn down with its agent), so
 * an org-shared sibling is the credential a run should be given; this is what
 * makes that the one that survives the dedup instead of whatever order storage
 * happened to return. Pure, and exported for its test.
 */
export function orgSharedFirst<T extends RepoConnection>(
  connections: T[],
): T[] {
  return [
    ...connections.filter(isOrgSharedConnection),
    ...connections.filter((c) => !isOrgSharedConnection(c)),
  ];
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
  legacy: {
    connectionId: string;
    owner: string;
    repo: string;
    installationId: number;
  }[],
): RepoChoice[] {
  const out: RepoChoice[] = [];
  const seen = new Set<string>();

  for (const repository of repositories) {
    const { owner, name } = splitOwnerName(repository);
    seen.add(`${repository.host}/${repository.path}`.toLowerCase());
    out.push({
      id: repository.id,
      owner,
      name,
      label: `${repository.path} (${repository.host})`,
      webUrl: repository.webUrl,
      repository,
      connectionId: null,
      installationId: undefined,
    });
  }

  for (const entry of legacy) {
    const key = `github.com/${entry.owner}/${entry.repo}`.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      id: entry.connectionId,
      owner: entry.owner,
      name: entry.repo,
      label: `${entry.owner}/${entry.repo} (github.com)`,
      webUrl: `https://github.com/${entry.owner}/${entry.repo}`,
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
  const { items } = await ctx.storage.connections.list(orgId, {
    slug: "mcp-github",
  });
  return mergeRepoChoices(servable, selectLoadableRepos(orgSharedFirst(items)));
}
