/**
 * "Open" in a test's or campaign's "Used by" lands on the site editor's
 * Content route, whose code is split out of the Experiments and Calendar
 * views. Fetched only on that click, it kept the site editor on a spinner
 * for seconds before the variant showed (the data was already in the cache).
 * The views fetch it once they show instead, so Open lands right away.
 */

let preloading: Promise<unknown> | null = null;

/** The site editor's shell and its Content route, fetched once per page. */
function preloadSiteEditorContent(): Promise<unknown> {
  preloading ??= Promise.all([
    import("@/routes/workspace/agent-site-editor.tsx"),
    import("@/routes/workspace/agent-site-editor-content.tsx"),
  ]).catch((error) => {
    // A failed fetch (offline, a new deploy) is tried again by the click.
    preloading = null;
    throw error;
  });
  return preloading;
}

/**
 * A ref for the element that shows once the view is ready: when it mounts,
 * `preload` runs on idle (never in the way of the view's own first paint).
 */
export function preloadOnShow(
  preload: () => Promise<unknown>,
): (node: HTMLElement | null) => void | (() => void) {
  return (node) => {
    if (!node) return;
    const run = () => void preload().catch(() => {});
    if (typeof requestIdleCallback === "function") {
      const id = requestIdleCallback(run, { timeout: 2000 });
      return () => cancelIdleCallback(id);
    }
    const id = setTimeout(run, 200);
    return () => clearTimeout(id);
  };
}

/** {@link preloadOnShow} for the site editor's Content route (one stable ref). */
export const preloadSiteEditorContentOnShow = preloadOnShow(
  preloadSiteEditorContent,
);
