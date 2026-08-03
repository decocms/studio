/**
 * Hosted chat is Decopilot-only. Coding-agent ids can still appear in
 * persisted native thread rows consumed by shared UI code, but the hosted AI
 * SDK dispatcher has no wire contract for them.
 *
 * Gate on both persisted pins. Decopilot's null and retired `user-desktop`
 * sandboxes are readable legacy hosted tuples; unknown sandboxes and every
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
  if (isDesktopApp) return false;
  if (
    harnessId !== null &&
    harnessId !== undefined &&
    harnessId !== "decopilot"
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
