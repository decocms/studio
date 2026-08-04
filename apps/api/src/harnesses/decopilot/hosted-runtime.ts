/** Persisted runtime tuples that the hosted Decopilot path may continue. */
export function isHostedDecopilotRuntime({
  harnessId,
  sandboxProviderKind,
}: {
  harnessId: string | null;
  sandboxProviderKind: string | null;
}): boolean {
  return harnessId === "decopilot" && sandboxProviderKind === "agent-sandbox";
}
