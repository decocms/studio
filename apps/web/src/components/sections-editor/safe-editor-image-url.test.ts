import { describe, expect, test } from "bun:test";
import { safeEditorImageUrl } from "./safe-editor-image-url";

describe("safeEditorImageUrl", () => {
  test("allows https URLs", () => {
    expect(safeEditorImageUrl("https://example.com/a.jpg")).toBe(
      "https://example.com/a.jpg",
    );
  });

  test("rejects non-https protocols", () => {
    expect(safeEditorImageUrl("http://example.com/a.jpg")).toBeUndefined();
    expect(safeEditorImageUrl("javascript:alert(1)")).toBeUndefined();
    expect(safeEditorImageUrl("data:image/png;base64,abc")).toBeUndefined();
  });

  test("rejects invalid and empty values", () => {
    expect(safeEditorImageUrl("")).toBeUndefined();
    expect(safeEditorImageUrl("not-a-url")).toBeUndefined();
  });
});
