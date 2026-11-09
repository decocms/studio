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

/**
 * A Blocks v8 page that shows a new URL of itself without loading it: Studio's
 * HTML swap module fetches the URL and swaps the page's HTML in
 * (studio-channel-host.ts `refresh`). The frame keeps the src it loaded,
 * `src`, so it doesn't navigate, while its document shows `shown`.
 */
export interface FrameSwap {
  /** The frame's base (`key` of the frame element): a new frame drops it. */
  base: string;
  /** The src the frame was given and loaded, which it keeps. */
  src: string;
  /** The URL the page shows. */
  shown: string;
}

export interface FrameSwapInputs {
  base: string;
  /** The src the frame would be given now (`HeldFrameNavigation.src`). */
  frameSrc: string | undefined;
  /** The src whose load the frame last finished. */
  loadedSrc: string | undefined;
  /** The URL to show. */
  wanted: string | undefined;
  /** The frame's document has HTML swap loaded. */
  canSwap: boolean;
}

/** The same page (origin and path): only its query moved, as a save's draft pointer does. */
function samePage(a: string, b: string): boolean {
  try {
    const x = new URL(a);
    const y = new URL(b);
    return x.origin === y.origin && x.pathname === y.pathname;
  } catch {
    return false;
  }
}

/**
 * Whether the frame shows `wanted` by swapping (the swap to ask for), or by
 * loading it (null: the frame's src follows `wanted`). It swaps only a new
 * URL of the page it shows, once that page finished loading, with HTML swap
 * in it. The same object comes back when nothing changes.
 */
export function nextFrameSwap(
  current: FrameSwap | null,
  { base, frameSrc, loadedSrc, wanted, canSwap }: FrameSwapInputs,
): FrameSwap | null {
  const live = current?.base === base ? current : null;
  const src = live?.src ?? frameSrc;
  const shown = live?.shown ?? frameSrc;
  if (!wanted || !src || !shown) return null;
  if (shown === wanted) return live;
  if (canSwap && loadedSrc === src && samePage(shown, wanted)) {
    return { base, src, shown: wanted };
  }
  return null;
}
