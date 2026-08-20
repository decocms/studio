/**
 * What the Preview / Code tabs have to show for the current thread.
 *
 * Two different things can back them:
 *   - "repo"    — a checked-out clonable source (the agent's repo, or a
 *                 thread-scoped repo bound by `load_repo` / `TASK_ADD_REPO`).
 *   - "sandbox" — no repo, but the thread's sandbox is serving a dev server, so
 *                 the preview can proxy that HTML directly.
 *   - "none"    — nothing to preview: the tabs are hidden entirely.
 *
 * A sandbox-hosted harness run (`claude-code`) works exclusively inside ITS OWN
 * sandbox, so the agent entity's repo is irrelevant to it — a QA Agent / Code
 * Reviewer / debugging run with no repo of its own used to inherit the agent's
 * `githubRepo`, show a Preview tab, and then render the "No source to preview —
 * Connect a GitHub repository" empty state meant for repo-backed projects. Such
 * a run resolves off its own thread repo, then its sandbox dev server, and
 * otherwise gets no Preview tab at all.
 */
export type PreviewSource = "repo" | "sandbox" | "none";

/** Harnesses whose loop runs inside the sandbox pod (mirrors the API's
 *  `SANDBOX_HOSTED_HARNESSES` in `harnesses/sandbox-dispatch-client.ts`). */
const SANDBOX_HOSTED_HARNESSES = new Set(["claude-code"]);

function harnessRunsInSandbox(harnessId: string | null | undefined): boolean {
  return !!harnessId && SANDBOX_HOSTED_HARNESSES.has(harnessId);
}

export function resolvePreviewSource(input: {
  /** `threads.harness_id` of the active thread, when pinned. */
  harnessId: string | null | undefined;
  /** The agent entity declares a clonable `githubRepo`. */
  agentHasRepo: boolean;
  /** The thread itself declares a clonable `githubRepo`. */
  threadHasRepo: boolean;
  /** The thread's sandbox is serving a dev server we can proxy. */
  hasSandboxPreviewUrl: boolean;
}): PreviewSource {
  const repo = harnessRunsInSandbox(input.harnessId)
    ? input.threadHasRepo
    : input.agentHasRepo || input.threadHasRepo;
  if (repo) return "repo";
  if (input.hasSandboxPreviewUrl) return "sandbox";
  return "none";
}
