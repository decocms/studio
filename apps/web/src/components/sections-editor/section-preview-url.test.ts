import { describe, expect, it } from "bun:test";
import { buildDraftPreviewUrl } from "./section-preview-url";

const PROD = "https://www.acme.com";

describe("buildDraftPreviewUrl", () => {
  it("targets the real page on the production origin", () => {
    // Not the daemon and not /live/previews: the site renders its OWN route, so
    // hydration and in-preview navigation work.
    const url = new URL(
      buildDraftPreviewUrl({
        productionUrl: PROD,
        previewUrl: "https://gimenes-abc-1234.preview-studio.decocms.com",
        version: "ff00",
        path: "/blog/hello",
      }),
    );
    expect(url.origin).toBe(PROD);
    expect(url.pathname).toBe("/blog/hello");
  });

  it("carries the token as <host[:port]>@<version> — an authority, never a URL", () => {
    // The site validates the authority against its configured preview-API
    // domains and derives the scheme itself; a full URL here would be the
    // SSRF surface the design exists to avoid.
    const url = new URL(
      buildDraftPreviewUrl({
        productionUrl: PROD,
        previewUrl: "https://gimenes-abc-1234.preview-studio.decocms.com",
        version: "ff00",
        path: "/",
      }),
    );
    expect(url.searchParams.get("__draft")).toBe(
      "gimenes-abc-1234.preview-studio.decocms.com@ff00",
    );
  });

  it("keeps the desktop link's per-run port in the token", () => {
    const url = new URL(
      buildDraftPreviewUrl({
        productionUrl: PROD,
        previewUrl: "http://gimenes-abc-1234.localhost:60534",
        version: "v1",
        path: "/",
      }),
    );
    expect(url.searchParams.get("__draft")).toBe(
      "gimenes-abc-1234.localhost:60534@v1",
    );
  });

  it("changes with the version, so a save re-navigates the frame", () => {
    const at = (version: string) =>
      buildDraftPreviewUrl({
        productionUrl: PROD,
        previewUrl: "https://h.preview-studio.decocms.com",
        version,
        path: "/",
      });
    expect(at("v1")).not.toBe(at("v2"));
  });

  it("preserves a production origin that carries a trailing slash", () => {
    const url = new URL(
      buildDraftPreviewUrl({
        productionUrl: "https://fila.vtex.app/",
        previewUrl: "https://h.preview-studio.decocms.com",
        version: "v1",
        path: "/institucional/historia",
      }),
    );
    expect(url.origin).toBe("https://fila.vtex.app");
    expect(url.pathname).toBe("/institucional/historia");
  });

  it("keeps path params already filled in", () => {
    const url = new URL(
      buildDraftPreviewUrl({
        productionUrl: PROD,
        previewUrl: "https://h.preview-studio.decocms.com",
        version: "v1",
        path: "/produto/tenis-123/p",
      }),
    );
    expect(url.pathname).toBe("/produto/tenis-123/p");
  });
});
