import { describe, expect, it } from "bun:test";
import { Hono } from "hono";
import { downloadsOnly, fsByteResponse } from "./fs-bytes";

const BYTES = new TextEncoder().encode("<svg><script>alert(1)</script></svg>");

async function headersFor(
  path: string,
  opts?: { downloadOnly?: boolean },
): Promise<Headers> {
  const app = new Hono();
  app.get("/", (c) => fsByteResponse(c, BYTES, path, false, opts));
  return (await app.request("/")).headers;
}

describe("downloadsOnly", () => {
  it("holds a scriptable file a task editor attached to download", () => {
    expect(downloadsOnly("uploads", "editor-files/report.html")).toBe(true);
    expect(downloadsOnly("uploads", "editor-files/feed.xml")).toBe(true);
    expect(downloadsOnly("uploads", "editor-images/logo.svg")).toBe(true);
    // Mislabelled as an image by whoever uploaded it; the extension decides.
    expect(downloadsOnly("uploads", "editor-images/shot.html")).toBe(true);
  });

  it("holds an archive, or a file of no type it knows, to download", () => {
    for (const path of [
      "editor-files/report.zip",
      "editor-files/installer.exe",
      "editor-files/notes",
    ]) {
      expect(downloadsOnly("uploads", path)).toBe(true);
    }
  });

  it("lets raster images and PDFs open in a tab", () => {
    for (const path of [
      "editor-images/shot.png",
      "editor-images/photo.jpeg",
      "editor-images/photo.avif",
      "editor-files/spec.pdf",
    ]) {
      expect(downloadsOnly("uploads", path)).toBe(false);
    }
  });

  it("judges the path the read serves, not the one in the URL", () => {
    expect(downloadsOnly("uploads", "./editor-files/report.html")).toBe(true);
    expect(
      downloadsOnly("uploads", "editor-images/../editor-files/report.html"),
    ).toBe(true);
    expect(downloadsOnly("uploads", "%65ditor-files/report.html")).toBe(true);
  });

  it("leaves files outside the editors' folders to the general policy", () => {
    expect(downloadsOnly("uploads", "decks/q3.html")).toBe(false);
    expect(downloadsOnly("home", "editor-files/report.html")).toBe(false);
  });
});

describe("fsByteResponse", () => {
  it("serves a download-only file as an inert attachment, named by the chip", async () => {
    const headers = await headersFor("editor-files/report.html", {
      downloadOnly: true,
    });
    expect(headers.get("content-disposition")).toBe("attachment");
    expect(headers.get("content-security-policy")).toBe(
      "sandbox; default-src 'none'",
    );
  });

  it("sandboxes an SVG or XML opened as a page, wherever it lives", async () => {
    for (const path of ["brand/logo.svg", "exports/feed.xml"]) {
      const csp = (await headersFor(path)).get("content-security-policy");
      expect(csp).toStartWith("sandbox;");
      expect(csp).not.toContain("allow-scripts");
    }
  });

  it("leaves HTML previews and plain images as they were", async () => {
    expect(
      (await headersFor("decks/q3.html")).get("content-security-policy"),
    ).toContain("allow-scripts");
    const png = await headersFor("editor-images/shot.png");
    expect(png.get("content-security-policy")).toBeNull();
    expect(png.get("content-disposition")).toBeNull();
  });
});
