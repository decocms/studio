/**
 * Drop pinned views whose connection is no longer attached to the agent.
 *
 * The agent settings panel only lists attached connections, so a pin left
 * behind by a detached one renders a tab with no toggle to turn it off.
 * An empty `attachedConnectionIds` means "not loaded yet" — keep everything.
 */
export function keepAttachedPinnedViews<T extends { connectionId: string }>(
  pinnedViews: T[],
  attachedConnectionIds: Iterable<string>,
): T[] {
  const attached = new Set(attachedConnectionIds);
  if (attached.size === 0) return pinnedViews;
  return pinnedViews.filter((pv) => attached.has(pv.connectionId));
}
