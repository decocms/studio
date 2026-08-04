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
import type {
  GithubRepo,
  SandboxMap,
  SandboxRecord,
} from "@decocms/shared/sdk";
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

/**
 * The user a sandbox is KEYED by: a thread-scoped branch (`thread:<id>[/<conn>]`)
 * keys by the thread's creator, everything else by the caller.
 *
 * Sandbox identity is per-user in three places that must agree — the claim
 * handle (`computeClaimHandle`), `sandbox_runner_state`'s PK, and the
 * `sandboxMap` key. Keyed by the CALLER, an org member opening a teammate's
 * thread got a SECOND sandbox: a private clone of the same git branch that
 * nobody can prompt (the chat is read-only for them) and whose shutdown
 * force-push races the owner's on that one branch. Keyed by the thread's
 * creator there is exactly one sandbox per thread, and every member resolves it
 * identically — a viewer's `/events`, `/read`, git and exec reach the live
 * daemon, and SANDBOX_START on an evicted one resumes it instead of forking a
 * copy.
 *
 * This is sandbox IDENTITY only. Credential resolution (env secrets, submodule
 * PATs) and audit fields stay keyed to the CALLER, so viewing a thread never
 * mints someone else's secrets into a sandbox: a secret the caller can't read is
 * skipped, exactly as it is today.
 *
 * Never throws; an absent thread falls back to the caller.
 */
export async function resolveSandboxUserId(
  ctx: StudioContext,
  branch: string | null | undefined,
  callerUserId: string,
): Promise<string> {
  const threadId = threadIdFromBranch(branch);
  if (!threadId) return callerUserId;
  const thread = await ctx.storage.threads.get(threadId).catch(() => null);
  return thread?.created_by ?? callerUserId;
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

/**
 * Read the branch the thread's sandbox was last actually on
 * (`metadata.headRef`), or null. See `sandbox/head-ref.ts` for why the derived
 * ref isn't enough. Never throws.
 */
export async function getThreadHeadRef(
  ctx: StudioContext,
  threadId: string | undefined | null,
): Promise<string | null> {
  const meta = await getThreadMeta(ctx, threadId);
  const ref = (meta as { headRef?: unknown } | null)?.headRef;
  return typeof ref === "string" && ref.length > 0 ? ref : null;
}

/**
 * Persist the branch a live daemon reports for this thread's sandbox. Merged
 * into existing metadata (never a blind overwrite — `githubRepo` and
 * `sandboxMap` live in the same bag). No-op when the thread is gone or the ref
 * is already recorded, so the caller can fire this on every daemon connect.
 * Never throws: losing the hint only costs the next boot its restore.
 */
export async function setThreadHeadRef(
  ctx: StudioContext,
  threadId: string,
  headRef: string,
): Promise<void> {
  const meta = await getThreadMeta(ctx, threadId);
  if (!meta) return;
  if (meta.headRef === headRef) return;
  await ctx.storage.threads
    .update(threadId, { metadata: { ...meta, headRef } })
    .catch((err) => console.warn("[thread-repo] setThreadHeadRef failed", err));
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
 * The sandbox isolation branch for a run — the key every sandbox consumer must
 * agree on.
 *
 * Two keying regimes:
 * - GitHub-linked agents (`githubRepo` set) need per-branch isolation so PR and
 *   branch workflows don't trample each other, falling back to a synthetic
 *   `thread:<id>` branch when no explicit branch is supplied yet. A repo bound
 *   to the THREAD (`load_repo`) wins over the agent's and pins its own branch,
 *   so switching repos yields a distinct sandbox.
 * - Ephemeral agents (no repo at all) share one sandbox per (user, agent)
 *   across threads, which cuts sandbox count linearly with thread count.
 *
 * Pure given its inputs, and shared: the decopilot fs tools and the
 * sandbox-hosted dispatch path both derive their branch here, because two
 * derivations that drift would provision two pods for one thread — or worse,
 * make the sandbox proxy 404 on a handle nobody claimed.
 */
export function resolveSandboxBranch(args: {
  threadId: string;
  /** Repo bound to the thread by `load_repo`; wins over the agent's. */
  threadRepo: GithubRepo | null;
  /** Repo configured on the agent (`virtualMcp.metadata.githubRepo`). */
  agentRepo?: GithubRepo | null;
  /** Explicit branch for this run, when the caller has one. */
  runBranch?: string | null;
}): string {
  if (args.threadRepo) {
    return threadBranch(args.threadId, args.threadRepo.connectionId);
  }
  if (!args.agentRepo) return "ephemeral";
  return args.runBranch ?? `thread:${args.threadId}`;
}

/** `resolveSandboxBranch` with the thread's bound repo read for you. */
export async function resolveSandboxBranchForThread(
  ctx: StudioContext,
  args: {
    threadId: string;
    agentRepo?: GithubRepo | null;
    runBranch?: string | null;
  },
): Promise<string> {
  return resolveSandboxBranch({
    ...args,
    threadRepo: await getThreadGithubRepo(ctx, args.threadId),
  });
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
