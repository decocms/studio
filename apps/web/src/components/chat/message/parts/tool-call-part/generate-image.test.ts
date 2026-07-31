import { describe, expect, test } from "bun:test";
import { getGeneratedImages } from "./generate-image.tsx";

describe("getGeneratedImages", () => {
  test("returns the array when images is a real array", () => {
    const images = [{ uri: "a.png", mediaType: "image/png" }];
    expect(getGeneratedImages({ images })).toBe(images);
  });

  test("returns undefined when images is missing", () => {
    expect(getGeneratedImages({})).toBeUndefined();
    expect(getGeneratedImages(undefined)).toBeUndefined();
  });

  // A malformed backend/MCP payload could send images as a non-array value
  // (e.g. an object or string) — without the Array.isArray guard, downstream
  // `images.map(...)` throws and crashes the message render.
  test("returns undefined when images is a non-array value", () => {
    expect(
      getGeneratedImages({
        images: { 0: { uri: "a.png" } } as unknown as Array<{
          mediaType: string;
        }>,
      }),
    ).toBeUndefined();
    expect(
      getGeneratedImages({
        images: "oops" as unknown as Array<{ mediaType: string }>,
      }),
    ).toBeUndefined();
  });
});
