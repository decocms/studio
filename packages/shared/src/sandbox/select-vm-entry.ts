/**
 * Pure selector for a sandbox entry out of a parsed branch map (keyed by
 * sandboxProviderKind). Prefers a hosted (non-user-desktop) entry, else the
 * first one present.
 *
 * Shared by the web preview context and server-side dev-connection resolver.
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
