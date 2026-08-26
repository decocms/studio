/**
 * Harnesses the hosted dispatcher can run. Must mirror `HOSTED_HARNESS_IDS` in
 * `apps/api/src/api/routes/decopilot/dispatch-run.ts` — a harness the server
 * dispatches but this list omits renders as "unavailable on the web" for a
 * thread that in fact runs fine (that is what happened to `claude-code`).
 *
 * `claude-code` runs in the hosted sandbox, not on the user's machine, so it is
 * viewable — and streamable — here, on the same per-thread tail as Decopilot.
 */
const HOSTED_HARNESS_IDS = new Set(["decopilot", "claude-code"]);

/**
 * Hosted chat runs a fixed set of harnesses. Coding-agent ids can still appear
 * in persisted native thread rows consumed by shared UI code, but the hosted AI
 * SDK dispatcher has no wire contract for them.
 *
 * Gate on the persisted harness. An unpinned thread is available; once pinned,
 * hosted web accepts only harnesses the hosted dispatcher can run.
 */
export function shouldBlockHostedRuntime({
  isDesktopApp,
  harnessId,
}: {
  isDesktopApp: boolean;
  harnessId: string | null | undefined;
}): boolean {
  if (isDesktopApp) return false;
  return harnessId != null && !HOSTED_HARNESS_IDS.has(harnessId);
}
