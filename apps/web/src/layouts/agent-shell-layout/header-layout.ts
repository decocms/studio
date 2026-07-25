/**
 * Space budget (px) that drives how many view tabs the main header renders.
 *
 * The header lays out as: [left group: chat + view tabs + tab-overflow] · [center:
 * Preview's page selector] · [right actions: CMS / branch / ⋯ / publish]. As the
 * panel narrows, controls drop in this order — button labels, then the 3rd tab,
 * then the 2nd, then the whole center — and NEVER reappear. The right actions
 * always survive.
 *
 * Only the tab COUNT lives here. Label collapse and the center's visibility are
 * container queries on `@container/panel-header` (see HeaderTabButton and
 * workspace-panel-group), because CSS can express them without measuring. The
 * count can't: dropping a tab changes which items render in the bar versus the
 * overflow popover, so it needs a real number in JS.
 *
 * It is computed from ONE pair of stable measurements — the header width and the
 * right-actions width — so nothing depends on the center gap, which grows when a
 * tab folds. `avail = headerWidth - rightWidth` is the room the left group +
 * center actually share.
 */
export const HEADER_W = {
  /** Left prefix that's always there: chat toggle + tab-overflow menu + gaps. */
  lead: 70,
  /** One labelled view tab. */
  tab: 132,
  /**
   * Room reserved for the center (Preview's page selector) when deciding the
   * tab count — enough that it reads its page name rather than squishing to a
   * bare chevron. This is ONLY an allowance in the tab budget: it no longer
   * gates the center's visibility, which is a container query hiding it below
   * 384px of header (see workspace-panel-group). The center therefore shows
   * with far less than this on narrow panels — the page name drops out around
   * 448px, leaving the icon row down to its 112px floor — accepted, on the
   * grounds that small controls beat absent ones.
   */
  middle: 232,
} as const;

/**
 * Given the header width and the measured right-actions width, decide how many
 * view tabs to show (the rest fold into the ⋯ menu). A monotonic function of
 * `avail = headerWidth - rightWidth`, so shrinking only ever drops tabs (never
 * brings one back). Widths are `-1` until measured — treat that as roomy so the
 * header opens fully and only tightens once real measurements land.
 *
 * A CSS safety net (the left group is `min-w-0`/overflow-hidden and shrinks)
 * guarantees the right actions are never clipped even if these estimates run
 * slightly optimistic — the tab group yields first.
 */
export function headerLayout(
  headerWidth: number,
  rightWidth: number,
): { maxTabs: number } {
  if (headerWidth < 0 || rightWidth < 0) return { maxTabs: 3 };
  const avail = headerWidth - rightWidth;
  const { lead, tab, middle } = HEADER_W;
  if (avail >= lead + 3 * tab + middle) return { maxTabs: 3 };
  if (avail >= lead + 2 * tab + middle) return { maxTabs: 2 };
  return { maxTabs: 1 };
}
