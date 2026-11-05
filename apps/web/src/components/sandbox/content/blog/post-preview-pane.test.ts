import { describe, expect, test } from "bun:test";
import { resolvePostPreviewBlock } from "./post-preview-pane";

const ready = {
  previewBaseUrl: "https://site.example",
  hasPostRoute: true,
  url: "https://site.example/blog/news/hello",
  isPlanning: false,
};

/**
 * The reasons are not interchangeable: telling a writer to fill in a slug they
 * already filled in, or showing them a blank frame, both read as a bug in the
 * editor rather than as the state the site is actually in.
 */
describe("resolvePostPreviewBlock", () => {
  test("a published post renders in a sandbox session — writing the file is enough", () => {
    expect(resolvePostPreviewBlock(ready)).toBeNull();
  });

  test("no origin yet outranks everything: nothing can render without a site", () => {
    expect(
      resolvePostPreviewBlock({
        ...ready,
        previewBaseUrl: null,
        hasPostRoute: false,
        url: null,
      }),
    ).toBe("no-origin");
  });

  test("a site with no post route cannot render any post", () => {
    expect(
      resolvePostPreviewBlock({ ...ready, hasPostRoute: false, url: null }),
    ).toBe("no-route");
  });

  test("a post still in planning is coming soon, even with a complete URL", () => {
    // No `__resolveType`, so a correct slug changes nothing: the sandbox's
    // dev server renders the post once it is scheduled.
    expect(resolvePostPreviewBlock({ ...ready, isPlanning: true })).toBe(
      "planning-soon",
    );
  });

  test("a missing slug is reported as such, not as a missing route", () => {
    expect(resolvePostPreviewBlock({ ...ready, url: null })).toBe(
      "missing-params",
    );
  });
});

/**
 * The frame is never created before someone looks at the pane: loading the
 * site costs a full server render, and an editor-only session should not ask
 * for one. Once mounted it stays mounted, so toggling is instant.
 */
describe("preview mount gate", () => {
  /** Mirrors the render-time latch in `PostPreviewPane`. */
  function simulate(visibility: boolean[]): boolean[] {
    let mounted = visibility[0] ?? false;
    return visibility.map((visible) => {
      if (visible && !mounted) mounted = true;
      return mounted;
    });
  }

  test("an editor-only session never renders the site", () => {
    expect(simulate([false, false, false])).toEqual([false, false, false]);
  });

  test("mounts on first sight and stays mounted through a toggle", () => {
    expect(simulate([false, true, false, true])).toEqual([
      false,
      true,
      true,
      true,
    ]);
  });

  test("a pane that opens side by side mounts immediately", () => {
    expect(simulate([true])).toEqual([true]);
  });
});
