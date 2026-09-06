import { describe, expect, it } from "bun:test";
import { showCmsPageSelector } from "./cms-controls";

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
