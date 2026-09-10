/**
 * Drop `metadata.ui` references to a removed connection.
 *
 * `pinnedViews` used to be the only field pruned when a connection left an
 * agent's aggregation (see `keepAttachedPinnedViews` on the web side, which
 * fixed the same orphan class for the tab bar). `homeTile` / `homeTiles` carry
 * the identical `connectionId` shape and are just as capable of stranding a
 * home-board tile that points at a connection which no longer exists — left
 * out of the original fix as a known gap, closed here.
 *
 * Pure so the prune logic is unit-tested without a database.
 */
export function pruneOrphanedUiRefs(
  ui: Record<string, unknown>,
  removedConnectionId: string,
): { ui: Record<string, unknown>; changed: boolean } {
  let changed = false;
  const next: Record<string, unknown> = { ...ui };

  const pinnedViews = ui.pinnedViews;
  if (Array.isArray(pinnedViews)) {
    const filtered = pinnedViews.filter(
      (pv: { connectionId: string }) => pv.connectionId !== removedConnectionId,
    );
    if (filtered.length !== pinnedViews.length) {
      changed = true;
      next.pinnedViews = filtered.length > 0 ? filtered : null;
    }
  }

  const homeTile = ui.homeTile as { connectionId?: string } | null | undefined;
  if (homeTile && homeTile.connectionId === removedConnectionId) {
    changed = true;
    next.homeTile = null;
  }

  const homeTiles = ui.homeTiles;
  if (Array.isArray(homeTiles)) {
    const filtered = homeTiles.filter(
      (t: { connectionId?: string }) => t.connectionId !== removedConnectionId,
    );
    if (filtered.length !== homeTiles.length) {
      changed = true;
      next.homeTiles = filtered.length > 0 ? filtered : null;
    }
  }

  return { ui: next, changed };
}
