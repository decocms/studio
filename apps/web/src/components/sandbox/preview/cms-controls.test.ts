import { describe, expect, it } from "bun:test";
import {
  cmsEditorActivation,
  showCmsPageSelector,
  showPreviewToolbarFor,
  visualEditorActivation,
} from "./cms-controls";

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
    servePreviewUrl: null,
  };

  it("shows it for a deco serve preview without a sandbox daemon", () => {
    expect(
      showPreviewToolbarFor({
        ...base,
        servePreviewUrl: "http://localhost:5180",
      }),
    ).toBe(true);
    expect(
      showCmsPageSelector({
        showPreviewToolbar: showPreviewToolbarFor({
          ...base,
          servePreviewUrl: "http://localhost:5180",
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
        servePreviewUrl: "http://localhost:5180",
      }),
    ).toBe(false);
  });
});

describe("cmsEditorActivation", () => {
  const script = "/* overlay */";

  it("sends a Blocks v8 frame nothing: its page evaluates no script Studio sends", () => {
    for (const production of [true, false]) {
      for (const localPreview of [true, false]) {
        expect(
          cmsEditorActivation({ v8: true, production, localPreview, script }),
        ).toBe(null);
      }
    }
  });

  it("a v7 Fast Preview production frame or Local tunnel takes the framework's editor::inject", () => {
    for (const [production, localPreview] of [
      [true, false],
      [false, true],
      [true, true],
    ] as const) {
      expect(
        cmsEditorActivation({ v8: false, production, localPreview, script }),
      ).toEqual({ type: "editor::inject", args: { script } });
    }
  });

  it("a v7 daemon-proxied sandbox takes visual-editor::activate", () => {
    expect(
      cmsEditorActivation({
        v8: false,
        production: false,
        localPreview: false,
        script,
      }),
    ).toEqual({ type: "visual-editor::activate", script });
  });
});

describe("visualEditorActivation", () => {
  const script = "/* visual editor */";

  it("sends a Blocks v8 frame nothing: neither activate nor the script", () => {
    expect(visualEditorActivation({ v8: true, script })).toBe(null);
  });

  it("a v7 sandbox takes visual-editor::activate with the script", () => {
    expect(visualEditorActivation({ v8: false, script })).toEqual({
      type: "visual-editor::activate",
      script,
    });
  });
});
