/** Hosted chat is Decopilot-only; explicitly retired rows stay read-only. */
export function shouldBlockHostedRuntime({
  isDesktopApp,
  hostedExecutionDisabledAt,
}: {
  isDesktopApp: boolean;
  hostedExecutionDisabledAt: string | null | undefined;
}): boolean {
  if (isDesktopApp) return false;
  return hostedExecutionDisabledAt != null;
}
