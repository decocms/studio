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
        sandboxHandle: "gimenes-abc-1234",
        version: "ff00",
        path: "/blog/hello",
      }),
    );
    expect(url.origin).toBe(PROD);
    expect(url.pathname).toBe("/blog/hello");
  });

  it("carries the pointer as <handle>@<version>, never a URL", () => {
    // A URL here would make the site fetch caller-supplied origins — the SSRF
    // surface the suffix-based design exists to avoid.
    const url = new URL(
      buildDraftPreviewUrl({
        productionUrl: PROD,
        sandboxHandle: "gimenes-abc-1234",
        version: "ff00",
        path: "/",
      }),
    );
    expect(url.searchParams.get("__draft")).toBe("gimenes-abc-1234@ff00");
  });

  it("changes with the version, so a save re-navigates the frame", () => {
    const at = (version: string) =>
      buildDraftPreviewUrl({
        productionUrl: PROD,
        sandboxHandle: "h",
        version,
        path: "/",
      });
    expect(at("v1")).not.toBe(at("v2"));
  });

  it("preserves a production origin that carries a trailing slash", () => {
    const url = new URL(
      buildDraftPreviewUrl({
        productionUrl: "https://fila.vtex.app/",
        sandboxHandle: "h",
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
        sandboxHandle: "h",
        version: "v1",
        path: "/produto/tenis-123/p",
      }),
    );
    expect(url.pathname).toBe("/produto/tenis-123/p");
  });
});
