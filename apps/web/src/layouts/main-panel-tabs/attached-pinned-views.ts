import type { VirtualMCPEntity } from "@decocms/shared/sdk/types";

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

export interface PinnedView {
  connectionId: string;
  toolName: string;
  label?: string;
  icon?: string | null;
}

/** A project's curated app views. The metadata bag is `.loose()`, so this
 *  validates the shape rather than trusting it. */
export function pinnedViewsOf(project: VirtualMCPEntity): PinnedView[] {
  const ui = (
    project.metadata as { ui?: { pinnedViews?: unknown } } | undefined
  )?.ui;
  if (!Array.isArray(ui?.pinnedViews)) return [];
  return ui.pinnedViews.filter(
    (pv): pv is PinnedView =>
      !!pv &&
      typeof pv === "object" &&
      typeof (pv as PinnedView).connectionId === "string" &&
      typeof (pv as PinnedView).toolName === "string" &&
      ["undefined", "string"].includes(typeof (pv as PinnedView).label) &&
      ((pv as PinnedView).icon == null ||
        typeof (pv as PinnedView).icon === "string"),
  );
}
