import { describe, expect, test } from "bun:test";
import { safeImageUrl } from "@/lib/safe-image-url";

describe("safeImageUrl", () => {
  test("allows https URLs", () => {
    expect(safeImageUrl("https://example.com/a.jpg")).toBe(
      "https://example.com/a.jpg",
    );
  });

  test("rejects non-https protocols", () => {
    expect(safeImageUrl("http://example.com/a.jpg")).toBeUndefined();
    expect(safeImageUrl("javascript:alert(1)")).toBeUndefined();
    expect(safeImageUrl("data:image/png;base64,abc")).toBeUndefined();
  });

  test("rejects invalid and empty values", () => {
    expect(safeImageUrl("")).toBeUndefined();
    expect(safeImageUrl("not-a-url")).toBeUndefined();
  });
});
