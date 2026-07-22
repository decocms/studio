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
import {
  deleteSandboxMapEntry,
  mergeSandboxMapEntry,
  readSandboxMap,
} from "./sandbox-map";

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
 * Real, deterministic git ref for a synthetic sandbox branch. The synthetic key
 * (`thread:<id>[/<connectionId>]`) is a sandbox isolation key, NOT a git ref —
 * the daemon deliberately never checks it out, so the working tree stays on the
 * repo default (main). That is how the shutdown sync used to push straight to
 * `main`. Mapping it to a real branch instead makes the daemon's normal path
 * take over: it forks this branch from the default on first boot, pushes it on
 * shutdown, and restores it on reboot (clone.ts ls-remote probe) — so a
 * per-thread sandbox's work lives in git on its own branch, never on `main`.
 *
 * Deterministic (same synthetic key → same ref) so a reboot restores the same
 * branch. Only `thread:*` keys reach git: `ephemeral` sandboxes have no repo.
 *   thread:abc/conn_1 → sandbox/thread-abc-conn_1
 */
export function syntheticBranchToGitRef(branch: string): string {
  const body = branch.replace(/^thread:/, "").replace(/\//g, "-");
  return `sandbox/thread-${body}`;
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

/** Read a thread's metadata JSON. Returns `null` only when the thread is
 *  absent (so writers can skip a non-existent row); an existing thread with a
 *  null metadata column returns `{}`. Never throws. `ctx.storage.threads` is
 *  already org-scoped, so only the thread id is needed. */
async function getThreadMeta(
  ctx: StudioContext,
  threadId: string | undefined | null,
): Promise<Record<string, unknown> | null> {
  if (!threadId) return null;
  const thread = await ctx.storage.threads.get(threadId).catch(() => null);
  if (!thread) return null;
  return (thread.metadata as Record<string, unknown> | null) ?? {};
}

/** Read the repo bound to a thread, or null. Never throws. */
export async function getThreadGithubRepo(
  ctx: StudioContext,
  threadId: string | undefined | null,
): Promise<GithubRepo | null> {
  const meta = await getThreadMeta(ctx, threadId);
  return (meta as { githubRepo?: GithubRepo } | null)?.githubRepo ?? null;
}

/**
 * Persist a sandbox record on the THREAD's `metadata.sandboxMap`
 * ([userId][branch][kind]) via the shared {@link mergeSandboxMapEntry}. The
 * synthetic Decopilot agent's sandboxMap write is a no-op, so for thread-scoped
 * branches this is the only place the frontend reads the live `previewUrl`/
 * handle from. Called from `provisionSandbox` so every provisioning path
 * (load_repo, the frontend's SANDBOX_START auto-start, the fs tools) persists
 * it — not just `load_repo`. Never throws.
 */
export async function setThreadSandboxMapEntry(
  ctx: StudioContext,
  threadId: string,
  userId: string,
  branch: string,
  kind: SandboxProviderKind,
  entry: SandboxRecord,
): Promise<void> {
  const meta = await getThreadMeta(ctx, threadId);
  if (!meta) return;
  const next = mergeSandboxMapEntry(
    readSandboxMap(meta),
    userId,
    branch,
    kind,
    entry,
  );
  await ctx.storage.threads
    .update(threadId, { metadata: { ...meta, sandboxMap: next } })
    .catch((err) =>
      console.warn("[thread-repo] setThreadSandboxMapEntry failed", err),
    );
}

/** The thread's sandboxMap ([userId][branch][kind]). `{}` when absent. Never
 *  throws. This is where the synthetic Decopilot agent's sandbox records live,
 *  so backend existence checks (the events handler) must read it here — the
 *  agent row is a no-op store for those. */
export async function getThreadSandboxMap(
  ctx: StudioContext,
  threadId: string | undefined | null,
): Promise<SandboxMap> {
  return readSandboxMap(await getThreadMeta(ctx, threadId));
}

/** Remove sandboxMap[userId][branch][kind] from the thread via the shared
 *  {@link deleteSandboxMapEntry}. No-op when the thread or entry is absent.
 *  Never throws. Mirrors the agent-scoped `removeSandboxMapEntry`. */
export async function removeThreadSandboxMapEntry(
  ctx: StudioContext,
  threadId: string,
  userId: string,
  branch: string,
  kind: SandboxProviderKind,
): Promise<void> {
  const meta = await getThreadMeta(ctx, threadId);
  if (!meta) return;
  const next = deleteSandboxMapEntry(
    readSandboxMap(meta),
    userId,
    branch,
    kind,
  );
  if (!next) return;
  await ctx.storage.threads
    .update(threadId, { metadata: { ...meta, sandboxMap: next } })
    .catch((err) =>
      console.warn("[thread-repo] removeThreadSandboxMapEntry failed", err),
    );
}
