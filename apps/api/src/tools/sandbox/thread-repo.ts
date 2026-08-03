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
import type { Thread } from "@/storage/types";
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

type ThreadSandboxAuthority = Pick<Thread, "virtual_mcp_id" | "created_by">;

export function threadBelongsToVirtualMcp(
  thread: ThreadSandboxAuthority,
  virtualMcpId: string,
): boolean {
  return thread.virtual_mcp_id === virtualMcpId;
}

/** Whether the authenticated caller owns the resolved sandbox identity. */
export function isSandboxOwner(
  callerUserId: string,
  sandboxUserId: string,
): boolean {
  return callerUserId === sandboxUserId;
}

class ThreadSandboxScopeError extends Error {
  constructor() {
    super("Thread does not belong to the requested Virtual MCP");
    this.name = "ThreadSandboxScopeError";
  }
}

class ThreadSandboxMutationDeniedError extends Error {
  constructor() {
    super("Only the thread owner can change its sandbox");
    this.name = "ThreadSandboxMutationDeniedError";
  }
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
 * identically. Viewers may observe the preview, lifecycle, and safe git status
 * surfaces; the proxy separately owner-gates filesystem, config, exec, and
 * control routes. SANDBOX_START on an evicted sandbox is owner-only.
 *
 * This is sandbox IDENTITY only. Credential resolution (env secrets, submodule
 * PATs) and audit fields stay keyed to the CALLER, so viewing a thread never
 * mints someone else's secrets into a sandbox: a secret the caller can't read is
 * skipped, exactly as it is today.
 *
 * A missing thread or Virtual MCP mismatch returns null. Callers must fail
 * closed instead of treating a forged `thread:*` key as a caller-owned branch.
 */
export async function resolveSandboxUserId(
  ctx: StudioContext,
  branch: string | null | undefined,
  callerUserId: string,
  virtualMcpId: string,
): Promise<string | null> {
  const threadId = threadIdFromBranch(branch);
  if (!threadId) return callerUserId;
  const thread = await ctx.storage.threads.get(threadId);
  if (!thread || !threadBelongsToVirtualMcp(thread, virtualMcpId)) return null;
  return thread.created_by;
}

/** Read a thread's metadata JSON. Returns `null` when the row is absent or its
 *  Virtual MCP does not match; an existing in-scope thread with null metadata
 *  returns `{}`. Storage is already organization-scoped. */
async function getThreadMeta(
  ctx: StudioContext,
  threadId: string | undefined | null,
  virtualMcpId: string,
): Promise<Record<string, unknown> | null> {
  if (!threadId) return null;
  const thread = await ctx.storage.threads.get(threadId);
  if (!thread) return null;
  if (!threadBelongsToVirtualMcp(thread, virtualMcpId)) {
    return null;
  }
  return (thread.metadata as Record<string, unknown> | null) ?? {};
}

/**
 * Read the branch the thread's sandbox was last actually on
 * (`metadata.headRef`), or null. See `sandbox/head-ref.ts` for why the derived
 * ref isn't enough.
 */
export async function getThreadHeadRef(
  ctx: StudioContext,
  threadId: string | undefined | null,
  virtualMcpId: string,
): Promise<string | null> {
  const meta = await getThreadMeta(ctx, threadId, virtualMcpId);
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
  virtualMcpId: string,
  actingUserId: string,
  sandboxUserId: string,
  headRef: string,
): Promise<void> {
  try {
    await assertThreadSandboxMutationAuthority(
      ctx,
      threadId,
      virtualMcpId,
      actingUserId,
      sandboxUserId,
    );
    const meta = await getThreadMeta(ctx, threadId, virtualMcpId);
    if (!meta || meta.headRef === headRef) return;
    await ctx.storage.threads.update(threadId, {
      metadata: { ...meta, headRef },
    });
  } catch (err) {
    console.warn("[thread-repo] setThreadHeadRef failed", err);
  }
}

/** Read the repo bound to an in-scope thread, or null when it is absent. */
export async function getThreadGithubRepo(
  ctx: StudioContext,
  threadId: string | undefined | null,
  virtualMcpId: string,
): Promise<GithubRepo | null> {
  const meta = await getThreadMeta(ctx, threadId, virtualMcpId);
  return (meta as { githubRepo?: GithubRepo } | null)?.githubRepo ?? null;
}

/**
 * Persist a sandbox record on the THREAD's `metadata.sandboxMap`
 * ([userId][branch][kind]) via the shared {@link mergeSandboxMapEntry}. The
 * synthetic Decopilot agent's sandboxMap write is a no-op, so for thread-scoped
 * branches this is the only place the frontend reads the live `previewUrl`/
 * handle from. Called from `provisionSandbox` so every provisioning path
 * (load_repo, the frontend's SANDBOX_START auto-start, the fs tools) persists
 * it — not just `load_repo`. Scope, ownership, and storage failures propagate
 * so callers cannot provision a sandbox whose authoritative record was lost.
 */
export async function setThreadSandboxMapEntry(
  ctx: StudioContext,
  threadId: string,
  virtualMcpId: string,
  actingUserId: string,
  sandboxUserId: string,
  branch: string,
  kind: SandboxProviderKind,
  entry: SandboxRecord,
): Promise<void> {
  const thread = await ctx.storage.threads.get(threadId);
  if (!thread || !threadBelongsToVirtualMcp(thread, virtualMcpId)) {
    throw new ThreadSandboxScopeError();
  }
  if (
    !isSandboxOwner(actingUserId, thread.created_by) ||
    !isSandboxOwner(sandboxUserId, thread.created_by)
  ) {
    throw new ThreadSandboxMutationDeniedError();
  }
  const meta = (thread.metadata as Record<string, unknown> | null) ?? {};
  const next = mergeSandboxMapEntry(
    readSandboxMap(meta),
    sandboxUserId,
    branch,
    kind,
    entry,
  );
  await ctx.storage.threads.update(threadId, {
    metadata: { ...meta, sandboxMap: next },
  });
}

/** The thread's sandboxMap ([userId][branch][kind]), or null when the thread is
 *  absent or outside the requested Virtual MCP. This is where the synthetic
 *  Decopilot agent's sandbox records live, so backend existence checks must
 *  read it here — the agent row is a no-op store for those. */
export async function getThreadSandboxMap(
  ctx: StudioContext,
  threadId: string | undefined | null,
  virtualMcpId: string,
): Promise<SandboxMap | null> {
  const meta = await getThreadMeta(ctx, threadId, virtualMcpId);
  return meta ? readSandboxMap(meta) : null;
}

/** Fail closed unless the acting user and sandbox owner are the thread owner. */
export async function assertThreadSandboxMutationAuthority(
  ctx: StudioContext,
  threadId: string,
  virtualMcpId: string,
  actingUserId: string,
  sandboxUserId: string,
): Promise<void> {
  const thread = await ctx.storage.threads.get(threadId);
  if (!thread || !threadBelongsToVirtualMcp(thread, virtualMcpId)) {
    throw new ThreadSandboxScopeError();
  }
  if (
    !isSandboxOwner(actingUserId, thread.created_by) ||
    !isSandboxOwner(sandboxUserId, thread.created_by)
  ) {
    throw new ThreadSandboxMutationDeniedError();
  }
}

export async function removeThreadSandboxMapEntryStrict(
  ctx: StudioContext,
  threadId: string,
  virtualMcpId: string,
  actingUserId: string,
  sandboxUserId: string,
  branch: string,
  kind: SandboxProviderKind,
): Promise<void> {
  await assertThreadSandboxMutationAuthority(
    ctx,
    threadId,
    virtualMcpId,
    actingUserId,
    sandboxUserId,
  );
  const meta = await getThreadMeta(ctx, threadId, virtualMcpId);
  if (!meta) throw new ThreadSandboxScopeError();
  const next = deleteSandboxMapEntry(
    readSandboxMap(meta),
    sandboxUserId,
    branch,
    kind,
  );
  if (!next) return;
  await ctx.storage.threads.update(threadId, {
    metadata: { ...meta, sandboxMap: next },
  });
}
