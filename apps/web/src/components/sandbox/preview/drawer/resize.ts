/** Smallest usable open-drawer height, in px. */
export const DRAWER_MIN_HEIGHT = 120;

/**
 * Space (px) reserved for the tab body (iframe/toolbar) above the drawer, so a
 * drag can never grow the drawer tall enough to swallow the pane. Kept in sync
 * with the `calc(100% - …)` max-height cap on the drawer element.
 */
export const DRAWER_TOP_RESERVE = 160;

/** One keyboard resize step, in px. Large enough to feel responsive while
 * still allowing precise adjustment with repeated arrow presses. */
export const DRAWER_KEYBOARD_STEP = 24;

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

/** Normalize the measured drawer range before exposing it through ARIA. */
export function resolveDrawerResizeMetrics(
  measuredHeight: number,
  paneHeight: number,
): { height: number; maxHeight: number } {
  return {
    height: Math.round(clampDrawerHeight(measuredHeight, paneHeight)),
    maxHeight: Math.round(
      Math.max(DRAWER_MIN_HEIGHT, paneHeight - DRAWER_TOP_RESERVE),
    ),
  };
}

/**
 * Resolve the keyboard contract for the horizontal drawer separator.
 *
 * ArrowUp grows the lower pane (the separator moves upward), ArrowDown shrinks
 * it, and Home/End expose the two bounds. Returning `null` lets the caller
 * leave unrelated key presses untouched.
 */
export function drawerHeightForKey(
  key: string,
  currentHeight: number,
  paneHeight: number,
  step = DRAWER_KEYBOARD_STEP,
): number | null {
  switch (key) {
    case "ArrowUp":
      return clampDrawerHeight(currentHeight + step, paneHeight);
    case "ArrowDown":
      return clampDrawerHeight(currentHeight - step, paneHeight);
    case "Home":
      return DRAWER_MIN_HEIGHT;
    case "End":
      return clampDrawerHeight(Number.POSITIVE_INFINITY, paneHeight);
    default:
      return null;
  }
}
