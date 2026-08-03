import { describe, expect, test } from "bun:test";

import { resolveLibraryPreviewCapabilities } from "./preview-capabilities";

describe("resolveLibraryPreviewCapabilities", () => {
  test("removes edit and share mutations from a read-only thread preview", () => {
    expect(resolveLibraryPreviewCapabilities(true, "home")).toEqual({
      canEditHtml: false,
      canShare: false,
    });
  });

  test("preserves the Library's existing mutation capabilities", () => {
    expect(resolveLibraryPreviewCapabilities(false, "home")).toEqual({
      canEditHtml: true,
      canShare: true,
    });
    expect(resolveLibraryPreviewCapabilities(false, "public")).toEqual({
      canEditHtml: false,
      canShare: true,
    });
  });
});
