/**
 * Thread-scoped repo binding.
 *
 * The Decopilot super-agent (and other ephemeral agents) has no persistent
 * `connections` row — its `virtualMcps.findById` returns a synthetic object, so
 * a repo can't be persisted on the agent. `load_repo` instead binds the chosen
 * repo to the current THREAD (`threads.metadata.githubRepo` + `threads.branch`,
 * both real, persisted columns), and sandbox provisioning prefers the thread's
 * repo over the agent's. This is also the natural per-conversation override for
 * real repo-agents.
 */

import type { StudioContext } from "@/core/studio-context";
import type { GithubRepo } from "@decocms/mesh-sdk";

/** Stable, per-thread sandbox branch used when a repo is loaded into a thread. */
export function threadBranch(threadId: string): string {
  return `thread:${threadId}`;
}

/** Read the repo bound to a thread, or null. Never throws. `ctx.storage.threads`
 *  is already org-scoped, so only the thread id is needed. */
export async function getThreadGithubRepo(
  ctx: StudioContext,
  threadId: string | undefined | null,
): Promise<GithubRepo | null> {
  if (!threadId) return null;
  const thread = await ctx.storage.threads.get(threadId).catch(() => null);
  const repo = (thread?.metadata as { githubRepo?: GithubRepo } | undefined)
    ?.githubRepo;
  return repo ?? null;
}
