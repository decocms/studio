import { describe, expect, test } from "bun:test";
import { getGeneratedImages, screenshotImageUrl } from "./generate-image.tsx";

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

describe("screenshotImageUrl", () => {
  test("reads the image URL from the JSON first line of the output", () => {
    const output =
      '{"image_url":"https://www.figma.com/api/mcp/asset/a.png","width":1024}\nThe screenshot is hosted at the URL above.';
    expect(screenshotImageUrl(output)).toBe(
      "https://www.figma.com/api/mcp/asset/a.png",
    );
  });

  test("ignores non-https URLs, non-JSON and non-string outputs", () => {
    expect(
      screenshotImageUrl('{"image_url":"javascript:alert(1)"}'),
    ).toBeNull();
    expect(
      screenshotImageUrl('{"image_url":"http://x.test/a.png"}'),
    ).toBeNull();
    expect(screenshotImageUrl("Bash completed with no output")).toBeNull();
    expect(
      screenshotImageUrl({ image_url: "https://x.test/a.png" }),
    ).toBeNull();
  });
});
