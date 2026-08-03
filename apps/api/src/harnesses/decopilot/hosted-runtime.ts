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

export function isRetiredLinkedDecopilotRuntime({
  harnessId,
  sandboxProviderKind,
}: {
  harnessId: string | null | undefined;
  sandboxProviderKind: string | null | undefined;
}): boolean {
  return harnessId === "decopilot" && sandboxProviderKind === "user-desktop";
}
