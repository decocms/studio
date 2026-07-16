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
import type { GithubRepo, SandboxMap, SandboxRecord } from "@decocms/mesh-sdk";
import type { SandboxProviderKind } from "@decocms/sandbox/provider";

/**
 * Per-thread sandbox branch for a loaded repo. Includes the repo's connection
 * id so switching repos yields a DISTINCT sandbox (handle + previewUrl), which
 * is what makes the preview UI react to a switch — the whole preview/lifecycle
 * machinery keys on the previewUrl changing. Falls back to a bare
 * `thread:<id>` (no repo / public clone) which stays stable.
 *
 * The daemon treats any `thread:`-prefixed branch as synthetic (never a git
 * ref), and the sandbox-proxy validator strips the prefix before its git-ref
 * charset check — so the extra `/` segment is safe.
 */
export function threadBranch(
  threadId: string,
  connectionId?: string | null,
): string {
  return connectionId
    ? `thread:${threadId}/${connectionId}`
    : `thread:${threadId}`;
}

/**
 * Extract the thread id from a synthetic sandbox branch
 * (`thread:<id>` or `thread:<id>/<connectionId>`), or null for non-thread
 * branches. Lets provisioning recover the thread repo from the branch alone,
 * without relying on `ctx.metadata.threadId` (absent on the frontend's
 * SANDBOX_START auto-start path).
 */
export function threadIdFromBranch(
  branch: string | null | undefined,
): string | null {
  if (!branch || !branch.startsWith("thread:")) return null;
  const id = branch.slice("thread:".length).split("/")[0];
  return id || null;
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

/**
 * Persist a sandbox record on the THREAD's `metadata.sandboxMap`
 * ([userId][branch][kind]), mirroring the agent-scoped `setSandboxMapEntry`.
 * The synthetic Decopilot agent's sandboxMap write is a no-op, so for
 * thread-scoped branches this is the only place the frontend can read the
 * live `previewUrl`/handle from. Called from `provisionSandbox` so every
 * provisioning path (load_repo, the frontend's SANDBOX_START auto-start, the
 * fs tools) persists it — not just `load_repo`. Never throws.
 */
export async function setThreadSandboxMapEntry(
  ctx: StudioContext,
  threadId: string,
  userId: string,
  branch: string,
  kind: SandboxProviderKind,
  entry: SandboxRecord,
): Promise<void> {
  const thread = await ctx.storage.threads.get(threadId).catch(() => null);
  if (!thread) return;
  const meta = (thread.metadata ?? {}) as Record<string, unknown>;
  const current = (meta.sandboxMap ?? {}) as SandboxMap;
  const userMap = { ...(current[userId] ?? {}) } as Record<
    string,
    Record<string, SandboxRecord>
  >;
  userMap[branch] = { ...(userMap[branch] ?? {}), [kind]: entry };
  const next = { ...current, [userId]: userMap } as SandboxMap;
  await ctx.storage.threads
    .update(threadId, { metadata: { ...meta, sandboxMap: next } })
    .catch((err) =>
      console.warn("[thread-repo] setThreadSandboxMapEntry failed", err),
    );
}
