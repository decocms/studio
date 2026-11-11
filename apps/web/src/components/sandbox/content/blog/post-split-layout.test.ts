import { describe, expect, test } from "bun:test";
import {
  clampEditorShare,
  POST_EDITOR_SHARE,
  POST_PREVIEW_MIN_WIDTH,
  resolvePostSplitLayout,
  showsPostPane,
  togglePostPane,
} from "./post-split-layout";

/**
 * The width is measured on the editor's container, which reports `-1` before
 * the first `ResizeObserver` callback. Reading that as "narrow" would render
 * the one-at-a-time switch and then reflow into a split a frame later.
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
    ).toEqual({ kind: "side-by-side", panes: "both" });
  });

  test("`edit` and `preview` show that pane alone at any width", () => {
    expect(resolvePostSplitLayout({ width: 1600, view: "edit" })).toEqual({
      kind: "side-by-side",
      panes: "edit",
    });
    expect(resolvePostSplitLayout({ width: 1600, view: "preview" })).toEqual({
      kind: "side-by-side",
      panes: "preview",
    });
    expect(resolvePostSplitLayout({ width: 900, view: "preview" })).toEqual({
      kind: "one-at-a-time",
      showing: "preview",
    });
  });
});

describe("showsPostPane", () => {
  test("an unmeasured screen paints as the editor", () => {
    expect(showsPostPane({ kind: "pending" }, "edit")).toBe(true);
    expect(showsPostPane({ kind: "pending" }, "preview")).toBe(false);
  });

  test("a split shows both, and a lone pane only itself", () => {
    const both = { kind: "side-by-side", panes: "both" } as const;
    expect(showsPostPane(both, "edit")).toBe(true);
    expect(showsPostPane(both, "preview")).toBe(true);
    const editor = { kind: "side-by-side", panes: "edit" } as const;
    expect(showsPostPane(editor, "edit")).toBe(true);
    expect(showsPostPane(editor, "preview")).toBe(false);
  });

  test("a narrow panel shows the pane its switch picked", () => {
    const preview = { kind: "one-at-a-time", showing: "preview" } as const;
    expect(showsPostPane(preview, "preview")).toBe(true);
    expect(showsPostPane(preview, "edit")).toBe(false);
  });
});

describe("togglePostPane", () => {
  test("hiding a pane of the split leaves the other alone", () => {
    expect(togglePostPane("both", "preview")).toBe("edit");
    expect(togglePostPane("both", "edit")).toBe("preview");
  });

  test("showing the hidden pane goes back to both, clearing the param", () => {
    expect(togglePostPane("edit", "preview")).toBeUndefined();
    expect(togglePostPane("preview", "edit")).toBeUndefined();
  });

  test("the pane showing alone can't be hidden", () => {
    expect(togglePostPane("edit", "edit")).toBeNull();
    expect(togglePostPane("preview", "preview")).toBeNull();
  });
});

describe("clampEditorShare", () => {
  test("keeps both panes usable", () => {
    expect(clampEditorShare(10)).toBe(POST_EDITOR_SHARE.min);
    expect(clampEditorShare(95)).toBe(POST_EDITOR_SHARE.max);
    expect(clampEditorShare(48.5)).toBe(48.5);
  });

  test("a stored value that isn't a number falls back to the default", () => {
    expect(clampEditorShare(Number.NaN)).toBe(POST_EDITOR_SHARE.default);
    expect(clampEditorShare(Number.POSITIVE_INFINITY)).toBe(
      POST_EDITOR_SHARE.default,
    );
  });
});
