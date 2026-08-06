import { describe, expect, it } from "bun:test";
import {
  buildDraftPreviewUrl,
  resolveSectionPreviewBase,
} from "./section-preview-url";

const PROD = "https://www.acme.com";
const SANDBOX = "https://h.preview-studio.decocms.com";

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

describe("resolveSectionPreviewBase", () => {
  it("prefers the sandbox dev server when Fast Preview is off", () => {
    expect(
      resolveSectionPreviewBase({
        sandboxUrl: SANDBOX,
        productionUrl: PROD,
        fastPreviewActive: false,
      }),
    ).toBe(SANDBOX);
  });

  it("uses production when Fast Preview is active, even if the sandbox is up", () => {
    // Mirrors the main canvas, which paints production for the whole Fast
    // Preview session rather than swapping to the sandbox once it boots.
    expect(
      resolveSectionPreviewBase({
        sandboxUrl: SANDBOX,
        productionUrl: PROD,
        fastPreviewActive: true,
      }),
    ).toBe(PROD);
  });

  it("uses production while the sandbox is still booting (no sandbox URL yet)", () => {
    expect(
      resolveSectionPreviewBase({
        sandboxUrl: null,
        productionUrl: PROD,
        fastPreviewActive: true,
      }),
    ).toBe(PROD);
  });

  it("falls back to the sandbox when Fast Preview is active but has no production URL", () => {
    // The `fastPreviewActive` gate already requires a production URL, so this
    // is defensive: a truthy flag with no URL must not blank the gallery.
    expect(
      resolveSectionPreviewBase({
        sandboxUrl: SANDBOX,
        productionUrl: null,
        fastPreviewActive: true,
      }),
    ).toBe(SANDBOX);
  });

  it("returns null when neither base is available", () => {
    expect(
      resolveSectionPreviewBase({
        sandboxUrl: null,
        productionUrl: null,
        fastPreviewActive: false,
      }),
    ).toBeNull();
  });

  it("never leaks production into the gallery when Fast Preview is off", () => {
    // The negative gate: a set productionUrl must be ignored unless the flag
    // is on, so the gallery is withheld rather than pointing at production.
    expect(
      resolveSectionPreviewBase({
        sandboxUrl: null,
        productionUrl: PROD,
        fastPreviewActive: false,
      }),
    ).toBeNull();
  });

  it("treats an undefined sandbox URL as absent", () => {
    expect(
      resolveSectionPreviewBase({
        sandboxUrl: undefined,
        productionUrl: undefined,
        fastPreviewActive: false,
      }),
    ).toBeNull();
  });
});
