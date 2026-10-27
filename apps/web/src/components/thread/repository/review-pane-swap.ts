/**
 * Which review pane the publish panel shows on a Blocks (v8) site. Clicking a
 * card selects it at once, but its pane takes the place of the one on screen
 * only when its pages have loaded: until then the previous pane stays, so the
 * previews never go blank in between. A pane that can't say it loaded (a site
 * that never answers) takes its place after {@link REVIEW_PANE_READY_MS}.
 */

/** How long a selected pane may wait on its pages before it shows anyway. */
export const REVIEW_PANE_READY_MS = 2500;

export function shownReviewPane(input: {
  /** The card picked. */
  selectedId: string | null;
  /** Panes whose pages have loaded (or that have none to load). */
  readyIds: ReadonlySet<string>;
  /** The pane on screen before this pick. */
  lastShownId: string | null;
  /** Panes still mounted; only those can stay on screen. */
  liveIds: readonly string[];
}): string | null {
  const { selectedId, readyIds, lastShownId, liveIds } = input;
  if (selectedId === null || readyIds.has(selectedId)) return selectedId;
  if (
    lastShownId !== null &&
    lastShownId !== selectedId &&
    liveIds.includes(lastShownId)
  ) {
    return lastShownId;
  }
  return selectedId;
}
