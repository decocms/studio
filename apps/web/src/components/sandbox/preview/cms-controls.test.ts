import { describe, expect, it } from "bun:test";
import {
  cmsEditorActivation,
  showPageSelector,
  showPreviewToolbarFor,
  visualEditorActivation,
} from "./cms-controls";

describe("showPageSelector", () => {
  it("shows it whenever content editing and the preview toolbar are enabled", () => {
    expect(
      showPageSelector({
        showPreviewToolbar: true,
        contentEditingEnabled: true,
        hasFrameworkRoutes: false,
      }),
    ).toBe(true);
  });

  it("hides it without content editing or router routes", () => {
    expect(
      showPageSelector({
        showPreviewToolbar: true,
        contentEditingEnabled: false,
        hasFrameworkRoutes: false,
      }),
    ).toBe(false);
  });

  it("shows the site's router routes without content editing", () => {
    expect(
      showPageSelector({
        showPreviewToolbar: true,
        contentEditingEnabled: false,
        hasFrameworkRoutes: true,
      }),
    ).toBe(true);
  });

  it("hides it when the toolbar itself is hidden", () => {
    expect(
      showPageSelector({
        showPreviewToolbar: false,
        contentEditingEnabled: true,
        hasFrameworkRoutes: false,
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
      showPageSelector({
        showPreviewToolbar: showPreviewToolbarFor({
          ...base,
          servePreviewUrl: "http://localhost:5180",
        }),
        contentEditingEnabled: true,
        hasFrameworkRoutes: false,
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
      ).toEqual({
        type: "editor::inject",
        args: { script },
      });
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
