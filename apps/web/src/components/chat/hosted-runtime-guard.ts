/**
 * Hosted chat is Decopilot-only. Coding-agent ids can still appear in
 * persisted native thread rows consumed by shared UI code, but the hosted AI
 * SDK dispatcher has no wire contract for them.
 *
 * Gate by harness alone rather than trusting the accompanying sandbox field:
 * an incomplete or older row must fail closed instead of reaching legacy
 * dispatch merely because `sandbox_provider_kind` is missing.
 */
export function shouldBlockHostedLegacyDispatch({
  isDesktopApp,
  harnessId,
}: {
  isDesktopApp: boolean;
  harnessId: string | null | undefined;
}): boolean {
  return (
    !isDesktopApp &&
    harnessId !== null &&
    harnessId !== undefined &&
    harnessId !== "decopilot"
  );
}
