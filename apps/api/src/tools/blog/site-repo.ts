import { isSyntheticBranch } from "@decocms/shared/is-synthetic-branch";
import { sameRepositoryBinding } from "@decocms/shared/repository-binding";
import type { RepositoryBinding } from "@decocms/shared/sdk/types/virtual-mcp";
import type { RepoContentClient } from "@/git-providers/content";
import {
  flatSandboxRef,
  getThreadRepository,
  syntheticBranchToGitRef,
} from "@/tools/sandbox/thread-repo";
import { contentClientForProjectRepo } from "@/git-providers";
import type { StudioContext } from "@/core/studio-context";
import { taskRunContextStore } from "../task-board/task-run-context";
import { parseRepositoryBinding } from "@/tools/sandbox/sync-git-credentials";
import { resolveCallerProjectScope } from "../../core/project-scope";
import { isProjectAllowed } from "@decocms/shared/auth/project-scope";

/**
 * Finding the repository behind a site, outside Hono.
 *
 * The decofile routes reach it through `resolveDecofileScope`, a middleware,
 * so a tool cannot borrow it. What the middleware does is not HTTP, though —
 * look up the project, check it is in the caller's scope, read its repository
 * binding, normalize the package path — and every blog tool that touches a
 * site's repository needs exactly that sequence. One copy, so a tool that
 * reads and a tool that writes cannot disagree about which repository, which
 * branch, or which package a site is.
 */

export interface SiteRepo {
  client: RepoContentClient;
  /** Where in the repository this site lives, when it is not the root. */
  packagePath: string | null;
  projectId: string;
  /** The binding the repository was resolved from. */
  repository: RepositoryBinding;
}

/** The site's project, when it is in the caller's organization and scope. */
export async function resolveSiteProject(
  ctx: StudioContext,
  organizationId: string,
  virtualMcpId: string,
) {
  const project = await ctx.storage.virtualMcps.findById(
    virtualMcpId,
    organizationId,
  );
  const scope = await resolveCallerProjectScope(ctx);
  if (
    !project ||
    project.organization_id !== organizationId ||
    !isProjectAllowed(scope, project.id)
  ) {
    throw new Error(`Project not found: ${virtualMcpId}`);
  }
  return project;
}

export async function resolveSiteRepo(
  ctx: StudioContext,
  organizationId: string,
  virtualMcpId: string,
): Promise<SiteRepo> {
  const project = await resolveSiteProject(ctx, organizationId, virtualMcpId);

  const metadata = (project.metadata as Record<string, unknown>) ?? null;
  const connectionIds =
    project.connections?.map((conn) => conn.connection_id) ?? [];
  const repository = parseRepositoryBinding(metadata, connectionIds);
  if (!repository) {
    throw new Error(
      "This site has no repository linked, so there is nothing to read or write.",
    );
  }

  const runtime = metadata?.runtime as { path?: string | null } | undefined;
  return {
    client: await contentClientForProjectRepo(ctx, organizationId, repository),
    packagePath: runtime?.path?.replace(/^\/+|\/+$/g, "") || null,
    projectId: project.id,
    repository,
  };
}

/**
 * The branch work done for a caller belongs on, or null when the caller has to
 * name one. Pure, so each case is pinned without a repository.
 *
 * An explicit branch wins, unless it is a sandbox key (`thread:…`), which is
 * not a git ref. Otherwise the caller's thread decides. A CMS session edits on
 * its own branch, and that is the only branch work done on its behalf belongs
 * on. A sandbox key maps to the ref its checkout is on, and only when that
 * sandbox cloned the site's repository: on any other repository the ref names
 * a branch the site does not have. Falling back to the repository's default
 * instead once put two generated posts straight onto a customer's `main`.
 */
export function resolveSiteBranch(args: {
  explicit: string | undefined;
  threadBranch: string | null | undefined;
  /** Whether the caller's sandbox cloned the site's repository. */
  sandboxOnSiteRepo: boolean;
  /** Whether that sandbox's checkout is on the flat ref (GitLab). */
  flat: boolean;
}): string | null {
  const explicit = args.explicit?.trim();
  if (explicit) {
    if (isSyntheticBranch(explicit)) {
      throw new Error(
        `"${explicit}" is a sandbox key, not a branch. Pass the git branch to use.`,
      );
    }
    return explicit;
  }
  const own = args.threadBranch?.trim();
  if (!own) return null;
  if (!isSyntheticBranch(own)) return own;
  if (!own.startsWith("thread:") || !args.sandboxOnSiteRepo) return null;
  return syntheticBranchToGitRef(own, { flat: args.flat });
}

/** {@link resolveSiteBranch} for the caller, refusing when it finds none. */
export async function requireBranch(
  ctx: StudioContext,
  site: SiteRepo,
  branch: string | undefined,
  verb: string,
): Promise<string> {
  const threadId =
    taskRunContextStore.getStore()?.threadId ?? ctx.metadata?.threadId;
  const thread =
    !branch?.trim() && threadId
      ? await ctx.storage.threads.get(threadId).catch(() => null)
      : null;
  const threadBranch = thread?.branch?.trim() || null;
  const sandboxRepo = threadBranch?.startsWith("thread:")
    ? await getThreadRepository(ctx, threadId).catch(() => null)
    : null;
  const resolved = resolveSiteBranch({
    explicit: branch,
    threadBranch,
    sandboxOnSiteRepo:
      !!sandboxRepo && sameRepositoryBinding(sandboxRepo, site.repository),
    flat: flatSandboxRef(site.client.repo.provider),
  });
  if (!resolved) {
    throw new Error(
      `No branch to ${verb}. Pass \`branch\`, or call this from a thread pinned to one. ` +
        "This refuses rather than guessing: the repository's default branch is production.",
    );
  }
  return resolved;
}

/**
 * {@link requireBranch} for a write, refusing the repository's default branch:
 * a draft written there is a commit on production, whoever asked for it.
 */
export async function requireWritableBranch(
  ctx: StudioContext,
  site: SiteRepo,
  branch: string | undefined,
): Promise<string> {
  const resolved = await requireBranch(ctx, site, branch, "write to");
  if (resolved === (await site.client.getDefaultBranch())) {
    throw new Error(
      `"${resolved}" is the repository's default branch, which is production. Write the draft on a branch of its own.`,
    );
  }
  return resolved;
}
