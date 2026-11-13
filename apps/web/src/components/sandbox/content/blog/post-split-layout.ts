import type { BlogPostView } from "./blog-search-params";

/**
 * Available width, in CSS pixels, below which the editor and the preview
 * cannot both be useful side by side. Measured on the EDITOR'S CONTAINER, not
 * the viewport: the chat panel is resizable and may be open, so the viewport
 * width routinely overstates the space the editor actually has.
 */
export const POST_PREVIEW_MIN_WIDTH = 1366;

/** What a wide panel shows: both panes, or one of them alone. */
export type PostSplitPanes = "both" | BlogPostView;

export type PostSplitLayout =
  /** Width not measured yet — render the editor alone rather than guess and
   *  reflow once the first measurement lands. */
  | { kind: "pending" }
  /** Too narrow for both: one pane shows, the switch picks it. The hidden
   *  pane stays MOUNTED, so swapping back does not reload the preview. */
  | { kind: "one-at-a-time"; showing: BlogPostView }
  /** Both fit. Each pane's toggle hides it, and the other takes the width. */
  | { kind: "side-by-side"; panes: PostSplitPanes };

/**
 * `view` is the URL's `?blogView=`: absent is whatever the width affords (both
 * panes when wide, the editor when narrow), and `edit` or `preview` shows that
 * pane alone, at any width.
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
  return { kind: "side-by-side", panes: input.view ?? "both" };
}

/** Whether `pane` is on screen. Unmeasured, the screen paints as the editor
 *  rather than as an empty frame. */
export function showsPostPane(
  layout: PostSplitLayout,
  pane: BlogPostView,
): boolean {
  switch (layout.kind) {
    case "pending":
      return pane === "edit";
    case "one-at-a-time":
      return layout.showing === pane;
    case "side-by-side":
      return layout.panes === "both" || layout.panes === pane;
  }
}

/**
 * The `view` a wide panel's toggle for `pane` writes: hiding it leaves the
 * other pane alone, and showing it again goes back to both (the param
 * cleared). `null` when the pane is showing alone: hiding it would leave
 * nothing, so its toggle is off.
 */
export function togglePostPane(
  panes: PostSplitPanes,
  pane: BlogPostView,
): BlogPostView | undefined | null {
  if (panes === "both") return pane === "edit" ? "preview" : "edit";
  return panes === pane ? null : undefined;
}

/** The editor's share of a split, in percent of the screen's width. */
export const POST_EDITOR_SHARE = { default: 55, min: 30, max: 75 } as const;

/** A stored or dragged share, kept where both panes stay usable. */
export function clampEditorShare(share: number): number {
  if (!Number.isFinite(share)) return POST_EDITOR_SHARE.default;
  return Math.min(
    POST_EDITOR_SHARE.max,
    Math.max(POST_EDITOR_SHARE.min, share),
  );
}
