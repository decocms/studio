/**
 * One Fast Preview navigation at a time. Every save gives the preview a new
 * `?__draft=` pointer, and setting the frame's src while it is still loading
 * the previous one cancels that load: the render it started is wasted, and
 * on a site with cross-document view transitions
 * (`@view-transition { navigation: auto }`) the page being left rejects its
 * `pageswap` transition with "AbortError: Transition was skipped" (QA-8027,
 * step 8). Instead, a new src waits for the frame's load and then the latest
 * one goes in; pointers in between are skipped, never queued.
 */

export interface HeldFrameNavigation {
  /** The src the frame was given. */
  src: string | undefined;
  /** Given and not loaded yet: a newer src waits. */
  loading: boolean;
}

/** Releases a held navigation whose load never fired (a failed frame). */
export const HELD_NAVIGATION_RELEASE_MS = 15_000;

/**
 * The frame's navigation once `wanted` is the src to show. Without `hold`
 * (not a Fast Preview frame) the frame follows `wanted` at once. The same
 * object comes back when nothing changes, so a render can set it only then.
 */
export function nextFrameNavigation(
  current: HeldFrameNavigation,
  wanted: string | undefined,
  hold: boolean,
): HeldFrameNavigation {
  if (!hold) {
    return current.src === wanted && !current.loading
      ? current
      : { src: wanted, loading: false };
  }
  if (current.src === wanted || current.loading) return current;
  return { src: wanted, loading: true };
}

/** The frame fired load: the next src may go in. */
export function frameNavigationLoaded(
  current: HeldFrameNavigation,
): HeldFrameNavigation {
  return current.loading ? { ...current, loading: false } : current;
}
