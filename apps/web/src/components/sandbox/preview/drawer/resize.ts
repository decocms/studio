/** Comfortable minimum for an open drawer when the pane has enough room. */
export const DRAWER_PREFERRED_MIN_HEIGHT = 120;

/**
 * Comfortable amount of routed content kept above the drawer in a normal pane.
 * Compact panes preserve a proportional share instead; see
 * {@link resolveDrawerResizeRange}.
 */
export const DRAWER_PREFERRED_TOP_RESERVE = 160;

/** In constrained panes Main remains primary: Drawer may use at most 45%. */
const COMPACT_DRAWER_MAX_RATIO = 0.45;

/** One keyboard resize step, in px. Large enough to feel responsive while
 * still allowing precise adjustment with repeated arrow presses. */
export const DRAWER_KEYBOARD_STEP = 24;

/**
 * One feasible live range for pointer, keyboard, CSS and ARIA consumers.
 *
 * Roomy panes retain the polished 120px minimum and 160px content reserve.
 * Below that threshold, the maximum becomes 45% of the available body and the
 * minimum contracts with it. This avoids an inverted range and keeps Preview,
 * Content, or Code usable even when the whole workspace is stacked into a
 * short landscape window.
 */
export function resolveDrawerResizeRange(
  paneHeight: number,
  reserve = DRAWER_PREFERRED_TOP_RESERVE,
): { minHeight: number; maxHeight: number } {
  const availableHeight = Math.max(0, Math.floor(paneHeight));
  const compactMaxHeight = Math.floor(
    availableHeight * COMPACT_DRAWER_MAX_RATIO,
  );
  const reservedMaxHeight = Math.max(0, availableHeight - Math.max(0, reserve));
  const maxHeight = Math.max(compactMaxHeight, reservedMaxHeight);
  return {
    minHeight: Math.min(DRAWER_PREFERRED_MIN_HEIGHT, maxHeight),
    maxHeight,
  };
}

/** Clamp a proposed height to the same adaptive range exposed everywhere. */
export function clampDrawerHeight(
  proposed: number,
  paneHeight: number,
  reserve = DRAWER_PREFERRED_TOP_RESERVE,
): number {
  const { minHeight, maxHeight } = resolveDrawerResizeRange(
    paneHeight,
    reserve,
  );
  return Math.min(Math.max(proposed, minHeight), maxHeight);
}

/** Normalize the measured drawer range before exposing it through ARIA. */
export function resolveDrawerResizeMetrics(
  measuredHeight: number,
  paneHeight: number,
): { height: number; minHeight: number; maxHeight: number } {
  const range = resolveDrawerResizeRange(paneHeight);
  return {
    height: Math.round(clampDrawerHeight(measuredHeight, paneHeight)),
    ...range,
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
      return resolveDrawerResizeRange(paneHeight).minHeight;
    case "End":
      return clampDrawerHeight(Number.POSITIVE_INFINITY, paneHeight);
    default:
      return null;
  }
}
