import { describe, expect, it } from "bun:test";
import { buildDownloadFilename, canForceDownload } from "./image-lightbox.tsx";

describe("buildDownloadFilename", () => {
  it("appends the extension from the image URL", () => {
    expect(
      buildDownloadFilename(
        "/api/acme/files/generated-images/abc-123.png",
        "A dragon guarding treasure",
      ),
    ).toBe("A dragon guarding treasure.png");
  });

  it("strips a query string before reading the extension", () => {
    expect(
      buildDownloadFilename(
        "/api/acme/files/generated-images/abc-123.jpg?v=2",
        "Sunset",
      ),
    ).toBe("Sunset.jpg");
  });

  it("falls back to no extension when the URL has none (e.g. a data: URI)", () => {
    expect(buildDownloadFilename("data:image/png;base64,abcd", "Sunset")).toBe(
      "Sunset",
    );
  });

  it("falls back to 'image' when alt sanitizes to empty", () => {
    expect(
      buildDownloadFilename("/api/acme/files/generated-images/abc.png", "!!!"),
    ).toBe("image.png");
  });
});

describe("canForceDownload", () => {
  const ORIGIN = "https://studio.decocms.com";

  it("allows a same-origin path", () => {
    expect(
      canForceDownload("/api/acme/files/generated-images/abc.png", ORIGIN),
    ).toBe(true);
  });

  it("allows a same-origin absolute URL", () => {
    expect(canForceDownload(`${ORIGIN}/api/acme/files/abc.png`, ORIGIN)).toBe(
      true,
    );
  });

  it("allows data: and blob: URIs", () => {
    expect(canForceDownload("data:image/png;base64,abcd", ORIGIN)).toBe(true);
    expect(canForceDownload("blob:https://x.com/abc", ORIGIN)).toBe(true);
  });

  it("rejects a cross-origin URL, where the download attribute is ignored", () => {
    expect(canForceDownload("https://evil.example/a.png", ORIGIN)).toBe(false);
  });

  it("treats a bare relative path as same-origin", () => {
    expect(canForceDownload("not-a-url-but-relative.png", ORIGIN)).toBe(true);
  });
});
