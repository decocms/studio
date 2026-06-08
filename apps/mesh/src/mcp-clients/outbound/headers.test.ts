import { describe, expect, it } from "bun:test";
import { MAX_TOKEN_IMAGE_LENGTH, imageForToken } from "./headers";

describe("imageForToken", () => {
  it("keeps plain http(s) avatar URLs", () => {
    expect(imageForToken("https://avatars.example.com/u/123.png")).toBe(
      "https://avatars.example.com/u/123.png",
    );
    expect(imageForToken("http://example.com/a.jpg")).toBe(
      "http://example.com/a.jpg",
    );
  });

  it("drops base64 data: URLs (would blow the x-mesh-token header)", () => {
    expect(
      imageForToken("data:image/jpeg;base64,/9j/4AAQSkZJRgABAQ=="),
    ).toBeUndefined();
  });

  it("drops oversized values even when not a data: URL", () => {
    const huge = `https://example.com/${"a".repeat(MAX_TOKEN_IMAGE_LENGTH)}`;
    expect(imageForToken(huge)).toBeUndefined();
  });

  it("passes a value exactly at the length cap", () => {
    const atCap = "h".repeat(MAX_TOKEN_IMAGE_LENGTH);
    expect(imageForToken(atCap)).toBe(atCap);
  });

  it("returns undefined for null/undefined/empty", () => {
    expect(imageForToken(null)).toBeUndefined();
    expect(imageForToken(undefined)).toBeUndefined();
    expect(imageForToken("")).toBeUndefined();
  });
});
