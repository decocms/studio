/**
 * Harnesses the hosted dispatcher can run. Must mirror `HOSTED_HARNESS_IDS` in
 * `apps/api/src/api/routes/decopilot/dispatch-run.ts` — a harness the server
 * dispatches but this list omits renders as "unavailable on the web" for a
 * thread that in fact runs fine (that is what happened to `claude-code`).
 *
 * `claude-code` runs in the hosted sandbox, not on the user's machine, so it is
 * viewable here.
 */
const HOSTED_HARNESS_IDS = new Set(["decopilot", "claude-code"]);

/**
 * Harnesses that run as a batch job rather than a live stream.
 *
 * `claude-code` executes its loop inside the sandbox pod and flushes whole turns
 * on the SDK's `result`, so there is no incremental stream to follow — the chat
 * renders persisted parts and learns about completion from the org-level
 * `/watch`. Decopilot streams token-by-token and is not in this set.
 */
export function isBatchHarness(harnessId: string | null | undefined): boolean {
  return harnessId === "claude-code";
}

/**
 * Hosted chat runs a fixed set of harnesses. Coding-agent ids can still appear
 * in persisted native thread rows consumed by shared UI code, but the hosted AI
 * SDK dispatcher has no wire contract for them.
 *
 * Gate on both persisted pins. A hosted harness on a null or `agent-sandbox`
 * sandbox is viewable; so is Decopilot's retired `user-desktop` sandbox, the one
 * readable legacy tuple. Unknown sandboxes and every non-hosted harness are
 * unavailable on hosted web — including `claude-code` pinned to `user-desktop`,
 * which is the native desktop coding agent rather than the sandbox-hosted one.
 */
export function shouldBlockHostedRuntime({
  isDesktopApp,
  harnessId,
  sandboxProviderKind,
}: {
  isDesktopApp: boolean;
  harnessId: string | null | undefined;
  sandboxProviderKind: string | null | undefined;
}): boolean {
  if (isDesktopApp) return false;
  if (
    harnessId !== null &&
    harnessId !== undefined &&
    !HOSTED_HARNESS_IDS.has(harnessId)
  ) {
    return true;
  }
  if (
    sandboxProviderKind === null ||
    sandboxProviderKind === undefined ||
    sandboxProviderKind === "agent-sandbox"
  ) {
    return false;
  }
  return !(harnessId === "decopilot" && sandboxProviderKind === "user-desktop");
}
