import { describe, expect, it } from "bun:test";
import {
  buildFastPreviewDraftUrl,
  resolveSectionPreviewBase,
} from "./section-preview-url";

const PROD = "https://www.acme.com";
const SANDBOX = "https://h.preview-studio.decocms.com";

const SCOPE = {
  productionUrl: PROD,
  apiHost: "studio.decocms.com",
  orgSlug: "fila",
  virtualMcpId: "vm-1",
  branch: "main",
  token: "tok.abc",
  version: "8c1d44e0f2a34567890123456789012345678901",
};

describe("buildFastPreviewDraftUrl", () => {
  it("targets the real page on the production origin", () => {
    // Not /live/previews: the site renders its OWN route, so hydration and
    // in-preview navigation work.
    const url = new URL(
      buildFastPreviewDraftUrl({ ...SCOPE, path: "/blog/hello" }),
    );
    expect(url.origin).toBe(PROD);
    expect(url.pathname).toBe("/blog/hello");
  });

  it("carries the pointer as <authority><path>?token=…@<version> — never a scheme", () => {
    // The runtime validates the authority against its configured preview-API
    // domains and derives the scheme itself; a full URL here would be the
    // SSRF surface the design exists to avoid.
    const url = new URL(buildFastPreviewDraftUrl({ ...SCOPE, path: "/" }));
    expect(url.searchParams.get("__draft")).toBe(
      `studio.decocms.com/api/fila/decofile/vm-1/main?token=tok.abc@${SCOPE.version}`,
    );
  });

  it("keeps a local dev port in the authority", () => {
    const url = new URL(
      buildFastPreviewDraftUrl({
        ...SCOPE,
        apiHost: "localhost:4000",
        path: "/",
      }),
    );
    expect(url.searchParams.get("__draft")).toBe(
      `localhost:4000/api/fila/decofile/vm-1/main?token=tok.abc@${SCOPE.version}`,
    );
  });

  it("percent-encodes branch and virtualMcpId path segments", () => {
    const url = new URL(
      buildFastPreviewDraftUrl({
        ...SCOPE,
        branch: "feat/hero",
        path: "/",
      }),
    );
    expect(url.searchParams.get("__draft")).toContain(
      "/decofile/vm-1/feat%2Fhero?token=",
    );
  });

  it("changes with the version, so a save re-navigates the frame", () => {
    const at = (version: string) =>
      buildFastPreviewDraftUrl({ ...SCOPE, version, path: "/" });
    expect(at("a".repeat(40))).not.toBe(at("b".repeat(40)));
  });

  it("preserves a production origin that carries a trailing slash", () => {
    const url = new URL(
      buildFastPreviewDraftUrl({
        ...SCOPE,
        productionUrl: "https://fila.vtex.app/",
        path: "/institucional/historia",
      }),
    );
    expect(url.origin).toBe("https://fila.vtex.app");
    expect(url.pathname).toBe("/institucional/historia");
  });

  it("keeps path params already filled in", () => {
    const url = new URL(
      buildFastPreviewDraftUrl({ ...SCOPE, path: "/produto/tenis-123/p" }),
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
