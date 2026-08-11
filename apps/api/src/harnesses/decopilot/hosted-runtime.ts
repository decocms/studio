/**
 * Persisted runtime tuples that the hosted Decopilot path may continue.
 * `user-desktop` is accepted only with Decopilot because the retired link
 * runtime wrote that exact tuple before hosted sandboxes became canonical.
 */
export function isHostedDecopilotRuntime({
  harnessId,
  sandboxProviderKind,
}: {
  harnessId: string | null | undefined;
  sandboxProviderKind: string | null | undefined;
}): boolean {
  return (
    harnessId === "decopilot" &&
    (sandboxProviderKind === null ||
      sandboxProviderKind === "agent-sandbox" ||
      sandboxProviderKind === "user-desktop")
  );
}

/**
 * Persisted runtime tuples a board-level nudge may re-prompt on the SAME
 * thread: hosted Decopilot, plus the sandbox-hosted `claude-code` Super Agent.
 *
 * The second one is not an extension, it is the common case: every Super Agent
 * run on an org with a repo imported is `claude-code` (`resolveTaskRepoChoice`),
 * so gating stall recovery on Decopilot alone meant the only recovery those
 * cards had was a full re-run — new thread, new sandbox, new branch, prompt from
 * scratch. Re-prompting the failed thread keeps its branch (the dead run's
 * commits are already pushed there) and its transcript.
 *
 * `user-desktop` stays Decopilot-only: the retired link runtime wrote that exact
 * tuple, and it has no sandbox to dispatch into.
 */
export function isNudgeableRuntime(runtime: {
  harnessId: string | null | undefined;
  sandboxProviderKind: string | null | undefined;
}): boolean {
  return (
    isHostedDecopilotRuntime(runtime) ||
    (runtime.harnessId === "claude-code" &&
      runtime.sandboxProviderKind === "agent-sandbox")
  );
}

export function isRetiredLinkedDecopilotRuntime({
  harnessId,
  sandboxProviderKind,
}: {
  harnessId: string | null | undefined;
  sandboxProviderKind: string | null | undefined;
}): boolean {
  return harnessId === "decopilot" && sandboxProviderKind === "user-desktop";
}
