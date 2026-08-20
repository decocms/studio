/**
 * Whether the Preview / Code tabs have a source to show for the current thread.
 *
 *   - "repo" — a checked-out clonable source: the agent's repo (the sandbox for
 *              this thread was provisioned from it) or a thread-scoped repo
 *              bound by `load_repo` / `TASK_ADD_REPO`.
 *   - "none" — nothing to preview or browse: both tabs are hidden entirely.
 *
 * The one case that has neither is a sandbox task run dispatched with NO repo
 * (QA Agent / Code Reviewer / debugging runs off the task board). Those run on
 * the bare synthetic `thread:<id>` sandbox key — `enqueueTaskRun` writes it on
 * the thread row precisely because the run has no repo of its own, and
 * `resolveSandboxBranch` keeps it (see `apps/api/src/tools/sandbox/thread-repo.ts`).
 * Such a run never checks out the agent's repo, so inheriting the agent's
 * `githubRepo` for tab visibility showed a Preview tab that then rendered the
 * "No source to preview — Connect a GitHub repository" empty state meant for
 * repo-backed projects.
 *
 * Every OTHER thread — including a normal chat thread on a GitHub-linked agent
 * that pinned the `claude-code` harness — keeps previewing the agent repo: its
 * sandbox IS the agent repo's checkout (`resolveSandboxBranch`'s `agentRepo`
 * path), and it never writes a thread-level `githubRepo`. Gating on the harness
 * id instead would strip Preview and Code from those threads.
 *
 * A repo-less run's sandbox dev server is deliberately NOT treated as a source:
 * the preview surface (`PreviewContent`) is built around a checkout — page list,
 * decofile, visual editor — so pointing it at a bare dev server would swap one
 * broken empty state for another. Hiding both tabs is the honest answer until
 * a real dev-server-only preview surface exists.
 */
type PreviewSource = "repo" | "none";

/**
 * The bare `thread:<id>` sandbox key, mirroring `threadBranch(threadId)` with no
 * connection id. A key WITH a connection id (`thread:<id>/<conn>`) is a
 * `load_repo` binding, which does have a repo and is not matched here.
 */
function isRepolessSandboxRun(
  threadId: string | null | undefined,
  sandboxBranch: string | null | undefined,
): boolean {
  return (
    !!threadId && !!sandboxBranch && sandboxBranch === `thread:${threadId}`
  );
}

export function resolvePreviewSource(input: {
  /** Id of the active thread. */
  threadId: string | null | undefined;
  /** `threads.branch` of the active thread — the sandbox isolation key. */
  sandboxBranch: string | null | undefined;
  /** The agent entity declares a clonable `githubRepo`. */
  agentHasRepo: boolean;
  /** The thread itself declares a clonable `githubRepo`. */
  threadHasRepo: boolean;
}): PreviewSource {
  if (input.threadHasRepo) return "repo";
  if (isRepolessSandboxRun(input.threadId, input.sandboxBranch)) return "none";
  return input.agentHasRepo ? "repo" : "none";
}
