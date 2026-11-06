import { describe, expect, test } from "bun:test";
import {
  nextPostView,
  POST_PREVIEW_MIN_WIDTH,
  resolvePostSplitLayout,
} from "./post-split-layout";

/**
 * The width is measured on the editor's container, which reports `-1` before
 * the first `ResizeObserver` callback. Reading that as "narrow" would render
 * the one-at-a-time toggle and then reflow into a split a frame later.
 */
describe("resolvePostSplitLayout", () => {
  test("waits for a real measurement instead of guessing", () => {
    expect(resolvePostSplitLayout({ width: -1, view: undefined }).kind).toBe(
      "pending",
    );
    expect(resolvePostSplitLayout({ width: -1, view: "preview" }).kind).toBe(
      "pending",
    );
  });

  test("a measured zero is narrow, not unmeasured", () => {
    expect(resolvePostSplitLayout({ width: 0, view: undefined })).toEqual({
      kind: "one-at-a-time",
      showing: "edit",
    });
  });

  test("splits at the breakpoint, not below it", () => {
    expect(
      resolvePostSplitLayout({
        width: POST_PREVIEW_MIN_WIDTH - 1,
        view: undefined,
      }).kind,
    ).toBe("one-at-a-time");
    expect(
      resolvePostSplitLayout({
        width: POST_PREVIEW_MIN_WIDTH,
        view: undefined,
      }),
    ).toEqual({ kind: "side-by-side", previewCollapsed: false });
  });

  test("the same URL reads as a split when wide and a pane when narrow", () => {
    expect(resolvePostSplitLayout({ width: 1600, view: "preview" })).toEqual({
      kind: "side-by-side",
      previewCollapsed: false,
    });
    expect(resolvePostSplitLayout({ width: 900, view: "preview" })).toEqual({
      kind: "one-at-a-time",
      showing: "preview",
    });
  });

  test("`edit` hides the preview on a wide panel rather than meaning nothing", () => {
    expect(resolvePostSplitLayout({ width: 1600, view: "edit" })).toEqual({
      kind: "side-by-side",
      previewCollapsed: true,
    });
  });
});

describe("nextPostView", () => {
  test("restoring a collapsed preview clears the param to the width's default", () => {
    expect(
      nextPostView({ kind: "side-by-side", previewCollapsed: true }),
    ).toBeUndefined();
  });

  test("collapsing writes `edit`, which survives a resize as 'preview hidden'", () => {
    expect(
      nextPostView({ kind: "side-by-side", previewCollapsed: false }),
    ).toBe("edit");
  });

  test("swaps panes on a narrow panel", () => {
    expect(nextPostView({ kind: "one-at-a-time", showing: "edit" })).toBe(
      "preview",
    );
    expect(nextPostView({ kind: "one-at-a-time", showing: "preview" })).toBe(
      "edit",
    );
  });

  test("an unmeasured panel has no pane to toggle to", () => {
    expect(nextPostView({ kind: "pending" })).toBeUndefined();
  });
});
