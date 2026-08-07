/** Smallest usable open-drawer height, in px. */
export const DRAWER_MIN_HEIGHT = 120;

/**
 * Space (px) reserved for the tab body (iframe/toolbar) above the drawer, so a
 * drag can never grow the drawer tall enough to swallow the pane. Kept in sync
 * with the `calc(100% - …)` max-height cap on the drawer element.
 */
export const DRAWER_TOP_RESERVE = 160;

/**
 * Clamp a proposed drawer height to `[DRAWER_MIN_HEIGHT, paneHeight - reserve]`.
 * The upper bound never drops below the lower one (tiny panes collapse to the
 * min rather than inverting the range).
 */
export function clampDrawerHeight(
  proposed: number,
  paneHeight: number,
  reserve = DRAWER_TOP_RESERVE,
): number {
  const max = Math.max(DRAWER_MIN_HEIGHT, paneHeight - reserve);
  return Math.min(Math.max(proposed, DRAWER_MIN_HEIGHT), max);
}
