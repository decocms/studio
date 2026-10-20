import { describe, expect, it } from "bun:test";
import { isImageMimeType } from "./node.tsx";

describe("isImageMimeType", () => {
  it("recognizes an image mime type", () => {
    expect(isImageMimeType("image/png")).toBe(true);
  });

  it("rejects a non-image mime type", () => {
    expect(isImageMimeType("application/pdf")).toBe(false);
  });

  // A chip parsed from HTML missing `data-mime-type` has a null mimeType.
  it("does not throw on a null mimeType", () => {
    expect(isImageMimeType(null)).toBe(false);
    expect(isImageMimeType(undefined)).toBe(false);
  });
});
