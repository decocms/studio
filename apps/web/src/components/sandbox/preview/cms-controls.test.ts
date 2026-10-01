import { describe, expect, it } from "bun:test";
import { showCmsPageSelector, showPreviewToolbar } from "./cms-controls";

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

describe("showPreviewToolbar", () => {
  const base = {
    previewSurfaceActive: true,
    daemonReady: false,
    productionDisplay: false,
    localPreview: false,
  };

  it("shows it for a Local tunnel even without a sandbox daemon", () => {
    expect(showPreviewToolbar({ ...base, localPreview: true })).toBe(true);
  });

  it("keeps the daemon and production gates", () => {
    expect(showPreviewToolbar({ ...base, daemonReady: true })).toBe(true);
    expect(showPreviewToolbar({ ...base, productionDisplay: true })).toBe(true);
    expect(showPreviewToolbar(base)).toBe(false);
  });

  it("hides it while the preview surface is inactive", () => {
    expect(
      showPreviewToolbar({
        ...base,
        previewSurfaceActive: false,
        localPreview: true,
      }),
    ).toBe(false);
  });
});
