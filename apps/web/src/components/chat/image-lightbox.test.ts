import { describe, expect, it } from "bun:test";
import { buildDownloadFilename } from "./image-lightbox.tsx";

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
