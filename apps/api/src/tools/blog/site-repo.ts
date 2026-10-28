import type { RepoContentClient } from "@/git-providers/content";
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
  };
}

/**
 * The branch the caller's session is on, or null.
 *
 * A CMS session edits on its own branch (`thread.branch`), and that is the only
 * branch work done on its behalf belongs on. Falling back to the repository's
 * default instead put two generated posts straight onto a customer's `main`;
 * they rendered nowhere, because a planning block carries no `__resolveType`,
 * but they were commits on production all the same.
 */
async function callerBranch(ctx: StudioContext): Promise<string | null> {
  const threadId =
    taskRunContextStore.getStore()?.threadId ?? ctx.metadata?.threadId;
  if (!threadId) return null;
  const thread = await ctx.storage.threads.get(threadId).catch(() => null);
  return thread?.branch?.trim() || null;
}

/** {@link callerBranch}, refusing rather than guessing when there is none. */
export async function requireBranch(
  ctx: StudioContext,
  branch: string | undefined,
  verb: string,
): Promise<string> {
  const resolved = branch?.trim() || (await callerBranch(ctx));
  if (!resolved) {
    throw new Error(
      `No branch to ${verb}. Pass \`branch\`, or call this from a thread pinned to one. ` +
        "This refuses rather than guessing: the repository's default branch is production.",
    );
  }
  return resolved;
}
