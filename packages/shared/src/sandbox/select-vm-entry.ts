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

/**
 * The sandbox entry to show for a thread whose provider kind is `kind`.
 *
 * An exact match on `kind` always wins, so a thread pinned to one provider
 * keeps showing that provider even when a sibling of another kind is live —
 * that pinning is the whole point of recording the kind.
 *
 * When `kind` has NO entry, degrade to whatever is actually serving the branch
 * rather than reporting "nothing". A missing entry for the pinned kind does not
 * mean the branch has no sandbox: the kind can be a stale or optimistic guess
 * (the client mirrors a runtime pin at send time before the server's own
 * resolution comes back), while a different kind is up and serving. Returning
 * null there blanks a working preview into the booting overlay AND makes
 * `shouldAutoStart` boot a second, competing sandbox.
 */
export function resolveVmEntry<T extends BranchMapEntryLike>(
  branchMap: Record<string, T>,
  kind: string | null | undefined,
): T | null {
  if (kind) return branchMap[kind] ?? selectVmEntry(branchMap);
  return selectVmEntry(branchMap);
}
