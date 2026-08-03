/**
 * Hosted chat is Decopilot-only. Coding-agent ids can still appear in
 * persisted native thread rows consumed by shared UI code, but the hosted AI
 * SDK dispatcher has no wire contract for them.
 *
 * Gate on both persisted pins. Explicit Decopilot with a null sandbox is a
 * supported legacy hosted tuple; explicit desktop/unknown sandboxes and every
 * non-Decopilot harness are unavailable on hosted web.
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
  return (
    !isDesktopApp &&
    ((harnessId !== null &&
      harnessId !== undefined &&
      harnessId !== "decopilot") ||
      (sandboxProviderKind !== null &&
        sandboxProviderKind !== undefined &&
        sandboxProviderKind !== "agent-sandbox"))
  );
}
