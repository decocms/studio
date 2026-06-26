/**
 * Pure selector for a sandbox entry out of a parsed branch map (keyed by
 * sandboxProviderKind). Prefers a hosted (non-user-desktop) entry, else the
 * first one present.
 *
 * Lives in a server-safe module (no web imports) so both the web preview
 * context and the server-side dev-connection resolver share one selection
 * rule. Re-exported from the web sandbox-lifecycle context for existing
 * importers.
 */

export interface BranchMapEntryLike {
  sandboxHandle: string;
  previewUrl: string | null;
  sandboxProviderKind: string;
  /** Epoch ms the sandbox was first created; used to pick the most recent. */
  createdAt?: number;
}

export function selectVmEntry<T extends BranchMapEntryLike>(
  branchMap: Record<string, T>,
): T | null {
  const entries = Object.values(branchMap);
  const [first] = entries;
  if (!first) return null;
  return entries.find((e) => e.sandboxProviderKind !== "user-desktop") ?? first;
}
