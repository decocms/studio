/**
 * Hosted chat is Decopilot-only. Coding-agent ids can still appear in
 * persisted native thread rows consumed by shared UI code, but the hosted AI
 * SDK dispatcher has no wire contract for them.
 *
 * Gate on the complete persisted tuple. Hosted web accepts an unpinned thread
 * before its first-message claim, or the exact Decopilot + agent-sandbox pin.
 * Partial, retired, and native tuples remain readable through shared thread
 * surfaces but cannot mount hosted chat execution.
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
  const isUnpinned =
    (harnessId === null || harnessId === undefined) &&
    (sandboxProviderKind === null ||
      sandboxProviderKind === undefined ||
      sandboxProviderKind === "agent-sandbox");
  const isHosted =
    harnessId === "decopilot" && sandboxProviderKind === "agent-sandbox";
  return !isUnpinned && !isHosted;
}
