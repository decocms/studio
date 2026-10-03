import { describe, expect, it } from "bun:test";
import { showCmsPageSelector, showPreviewToolbarFor } from "./cms-controls";

describe("showCmsPageSelector", () => {
  it("shows it whenever content editing and the preview toolbar are enabled", () => {
    expect(
      showCmsPageSelector({
        showPreviewToolbar: true,
        contentEditingEnabled: true,
      }),
    ).toBe(true);
  });

  it("hides it under the same disabled gate as Content and Blocks", () => {
    expect(
      showCmsPageSelector({
        showPreviewToolbar: true,
        contentEditingEnabled: false,
      }),
    ).toBe(false);
  });

  it("hides it when the toolbar itself is hidden", () => {
    expect(
      showCmsPageSelector({
        showPreviewToolbar: false,
        contentEditingEnabled: true,
      }),
    ).toBe(false);
  });
});

describe("showPreviewToolbarFor", () => {
  const base = {
    previewSurfaceActive: true,
    daemonReady: false,
    production: false,
    localPreviewUrl: null,
  };

  it("shows it for a local preview URL without a sandbox daemon", () => {
    expect(
      showPreviewToolbarFor({
        ...base,
        localPreviewUrl: "http://localhost:5180",
      }),
    ).toBe(true);
    expect(
      showCmsPageSelector({
        showPreviewToolbar: showPreviewToolbarFor({
          ...base,
          localPreviewUrl: "http://localhost:5180",
        }),
        contentEditingEnabled: true,
      }),
    ).toBe(true);
  });

  it("shows it for a ready daemon or production", () => {
    expect(showPreviewToolbarFor({ ...base, daemonReady: true })).toBe(true);
    expect(showPreviewToolbarFor({ ...base, production: true })).toBe(true);
  });

  it("hides it with nothing servable or no preview surface", () => {
    expect(showPreviewToolbarFor(base)).toBe(false);
    expect(
      showPreviewToolbarFor({
        ...base,
        previewSurfaceActive: false,
        localPreviewUrl: "http://localhost:5180",
      }),
    ).toBe(false);
  });
});
