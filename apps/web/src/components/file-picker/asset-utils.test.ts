import { describe, expect, it } from "bun:test";
import { basename, extensionTag, formatSize, isImageKey } from "./asset-utils";

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

describe("formatSize", () => {
  it("formats bytes, KB, and MB", () => {
    expect(formatSize(512)).toBe("512 B");
    expect(formatSize(2048)).toBe("2.0 KB");
    expect(formatSize(5 * 1024 * 1024)).toBe("5.0 MB");
  });
});
