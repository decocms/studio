import { describe, expect, it } from "bun:test";
import {
  aspectRatioDiffers,
  assetKind,
  basename,
  displayName,
  extensionTag,
  formatSize,
  isImageKey,
  isVideoKey,
  previewUrl,
  sameFormat,
} from "./asset-utils";

describe("isImageKey", () => {
  it("matches common image extensions case-insensitively", () => {
    for (const key of [
      "a.png",
      "b.JPG",
      "c.jpeg",
      "d.gif",
      "e.webp",
      "f.svg",
      "g.avif",
      "h.bmp",
      "nested/path/i.PNG",
    ]) {
      expect(isImageKey(key)).toBe(true);
    }
  });

  it("rejects non-image and extensionless keys", () => {
    for (const key of ["a.pdf", "b.mp4", "c.txt", "noext", "trailingdot."]) {
      expect(isImageKey(key)).toBe(false);
    }
  });
});

describe("extensionTag", () => {
  it("returns the lowercased extension", () => {
    expect(extensionTag("photo.PNG")).toBe("png");
    expect(extensionTag("dir/archive.tar.gz")).toBe("gz");
  });

  it('falls back to "file" without a usable extension', () => {
    expect(extensionTag("README")).toBe("file");
    expect(extensionTag("trailingdot.")).toBe("file");
  });
});

describe("basename", () => {
  it("returns the last path segment", () => {
    expect(basename("2026/01/uuid-name.png")).toBe("uuid-name.png");
    expect(basename("flat.png")).toBe("flat.png");
  });
});

describe("isVideoKey", () => {
  it("matches common video extensions case-insensitively", () => {
    for (const key of ["a.mp4", "b.WEBM", "c.mov", "d.m4v", "e.ogv"]) {
      expect(isVideoKey(key)).toBe(true);
    }
  });

  it("rejects images, documents, and extensionless keys", () => {
    for (const key of ["a.png", "b.pdf", "noext", "mp4"]) {
      expect(isVideoKey(key)).toBe(false);
    }
  });
});

describe("assetKind", () => {
  it("groups keys into image, video, and document", () => {
    expect(assetKind("2026/01/hero.webp")).toBe("image");
    expect(assetKind("2026/01/clip.mp4")).toBe("video");
    expect(assetKind("2026/01/sizes.pdf")).toBe("document");
    expect(assetKind("README")).toBe("document");
  });
});

describe("displayName", () => {
  it("drops the upload's uuid prefix", () => {
    expect(
      displayName(
        "site/2026/01/3f2a9c1e-5b7d-4e8a-9c21-7d4e5f6a8b90-hero-verao.webp",
      ),
    ).toBe("hero-verao.webp");
  });

  it("keeps names without a uuid prefix", () => {
    expect(displayName("2026/01/hero-verao.webp")).toBe("hero-verao.webp");
    expect(displayName("flat.png")).toBe("flat.png");
  });

  it("keeps a bare uuid that has no name after it", () => {
    const bare = "3f2a9c1e-5b7d-4e8a-9c21-7d4e5f6a8b90-";
    expect(displayName(bare)).toBe(bare);
  });
});

describe("sameFormat", () => {
  it("matches the extension case-insensitively, treating jpeg as jpg", () => {
    expect(sameFormat("2026/01/uuid-hero.jpg", "Hero Novo.JPEG")).toBe(true);
    expect(sameFormat("2026/01/uuid-clip.mp4", "clip-v2.mp4")).toBe(true);
  });

  it("rejects a different format", () => {
    expect(sameFormat("2026/01/uuid-hero.jpg", "hero.png")).toBe(false);
    expect(sameFormat("2026/01/uuid-guide.pdf", "guide")).toBe(false);
  });
});

describe("previewUrl", () => {
  const url = "https://cdn.example.com/2026/01/uuid-hero.jpg";

  it("adds the modification time as a version", () => {
    expect(previewUrl(url, "2026-11-17T12:40:14.000Z")).toBe(
      `${url}?v=${Date.parse("2026-11-17T12:40:14.000Z")}`,
    );
    expect(previewUrl(`${url}?w=200`, "2026-11-17T12:40:14.000Z")).toBe(
      `${url}?w=200&v=${Date.parse("2026-11-17T12:40:14.000Z")}`,
    );
  });

  it("keeps the URL without a usable modification time", () => {
    expect(previewUrl(url, null)).toBe(url);
    expect(previewUrl(url, "not a date")).toBe(url);
  });
});

describe("aspectRatioDiffers", () => {
  it("ignores a size change that keeps the proportion", () => {
    expect(
      aspectRatioDiffers(
        { width: 1600, height: 900 },
        { width: 800, height: 450 },
      ),
    ).toBe(false);
  });

  it("flags a different proportion", () => {
    expect(
      aspectRatioDiffers(
        { width: 1200, height: 1600 },
        { width: 1600, height: 900 },
      ),
    ).toBe(true);
  });

  it("never flags an unmeasured size", () => {
    expect(
      aspectRatioDiffers({ width: 0, height: 0 }, { width: 800, height: 450 }),
    ).toBe(false);
  });
});

describe("formatSize", () => {
  it("formats bytes, KB, and MB", () => {
    expect(formatSize(512)).toBe("512 B");
    expect(formatSize(2048)).toBe("2.0 KB");
    expect(formatSize(5 * 1024 * 1024)).toBe("5.0 MB");
  });
});
