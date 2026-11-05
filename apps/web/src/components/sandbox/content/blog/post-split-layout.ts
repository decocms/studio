import type { BlogPostView } from "./blog-search-params";

/**
 * Available width, in CSS pixels, below which the editor and the preview
 * cannot both be useful side by side. Measured on the EDITOR'S CONTAINER, not
 * the viewport: the chat panel is resizable and may be open, so the viewport
 * width routinely overstates the space the editor actually has.
 */
export const POST_PREVIEW_MIN_WIDTH = 1366;

export type PostSplitLayout =
  /** Width not measured yet — render the editor alone rather than guess and
   *  reflow once the first measurement lands. */
  | { kind: "pending" }
  /** Too narrow for both: one pane shows, the toggle swaps them. The hidden
   *  pane stays MOUNTED, so swapping back does not reload the preview. */
  | { kind: "one-at-a-time"; showing: BlogPostView }
  /** Both fit. The toggle collapses and restores the preview instead. */
  | { kind: "side-by-side"; previewCollapsed: boolean };

/**
 * `view` is the URL's `?blogView=`, so three values mean three things:
 * absent is "whatever this width affords", `edit` hides the preview, and
 * `preview` brings it forward. A link therefore survives a resize: the same
 * URL reads as a split on a wide panel and as the preview pane on a narrow one.
 */
export function resolvePostSplitLayout(input: {
  /** `-1` until the first `ResizeObserver` measurement — never `0`. */
  width: number;
  view: BlogPostView | undefined;
}): PostSplitLayout {
  if (input.width < 0) return { kind: "pending" };
  if (input.width < POST_PREVIEW_MIN_WIDTH) {
    return { kind: "one-at-a-time", showing: input.view ?? "edit" };
  }
  return { kind: "side-by-side", previewCollapsed: input.view === "edit" };
}

/** What the toggle writes next. `undefined` clears the param back to the
 *  width's own default, so a collapsed preview on a wide panel is one click
 *  from being a split again. */
export function nextPostView(
  layout: PostSplitLayout,
): BlogPostView | undefined {
  switch (layout.kind) {
    case "pending":
      return undefined;
    case "one-at-a-time":
      return layout.showing === "edit" ? "preview" : "edit";
    case "side-by-side":
      return layout.previewCollapsed ? undefined : "edit";
  }
}
