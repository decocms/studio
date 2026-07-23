/**
 * Space budget (px) that drives the main header's responsive degradation.
 *
 * The header lays out as: [left group: chat + view tabs + tab-overflow] · [center:
 * Preview's page selector] · [right actions: CMS / branch / ⋯ / publish]. As the
 * panel narrows, controls drop in this exact order — 3rd tab, then 2nd tab, then
 * the whole center — and NEVER reappear (see `headerLayout`). The right actions
 * always survive.
 *
 * Both decisions are computed from ONE pair of stable measurements — the header
 * width and the right-actions width — so nothing depends on the center gap (which
 * grows when a tab folds and previously made the selector flicker back). `avail =
 * headerWidth - rightWidth` is the room the left group + center actually share.
 */
export const HEADER_W = {
  /** Left prefix that's always there: chat toggle + tab-overflow menu + gaps. */
  lead: 70,
  /** One labelled view tab. */
  tab: 132,
  /**
   * Room the center (Preview's page selector) needs before it's shown at all —
   * generous enough that when it DOES show it reads its page name instead of
   * squishing to a bare chevron. Below this it's hidden (display:none), not
   * shrunk.
   */
  middle: 232,
} as const;

/**
 * Given the header width and the measured right-actions width, decide how many
 * view tabs to show (rest fold into the ⋯ menu) and whether the center page
 * selector shows. Both are a monotonic function of `avail = headerWidth -
 * rightWidth`, so shrinking only ever drops controls (never brings one back).
 * Widths are `-1` until measured — treat that as roomy so the header opens fully
 * and only tightens once real measurements land.
 *
 * A CSS safety net (the left group is `min-w-0`/overflow-hidden and shrinks)
 * guarantees the right actions are never clipped even if these estimates run
 * slightly optimistic — the tab group yields first.
 */
export function headerLayout(
  headerWidth: number,
  rightWidth: number,
): { maxTabs: number; showPageSelector: boolean } {
  if (headerWidth < 0 || rightWidth < 0) {
    return { maxTabs: 3, showPageSelector: true };
  }
  const avail = headerWidth - rightWidth;
  const { lead, tab, middle } = HEADER_W;
  if (avail >= lead + 3 * tab + middle)
    return { maxTabs: 3, showPageSelector: true };
  if (avail >= lead + 2 * tab + middle)
    return { maxTabs: 2, showPageSelector: true };
  if (avail >= lead + 1 * tab + middle)
    return { maxTabs: 1, showPageSelector: true };
  return { maxTabs: 1, showPageSelector: false };
}
