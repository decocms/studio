import { describe, expect, it } from "bun:test";
import {
  productionUrlFromSiteSlug,
  resolvePreviewDisplay,
} from "./preview-display";
import type { PreviewState } from "./preview-state";

const IFRAME: PreviewState = {
  kind: "iframe",
  previewUrl: "https://sandbox.example.deco.host",
};
const STARTING: PreviewState = { kind: "starting" };
const SUSPENDED: PreviewState = { kind: "suspended" };
const ERRORED: PreviewState = {
  kind: "errored",
  error: { code: null, message: "boom" },
};

const PROD = "https://acme.deco.site";

describe("productionUrlFromSiteSlug", () => {
  it("derives the deco.site URL from a slug", () => {
    expect(productionUrlFromSiteSlug("acme")).toBe("https://acme.deco.site");
  });

  it("trims surrounding whitespace", () => {
    expect(productionUrlFromSiteSlug("  acme  ")).toBe(
      "https://acme.deco.site",
    );
  });

  it("returns null for empty / whitespace / nullish", () => {
    expect(productionUrlFromSiteSlug(null)).toBeNull();
    expect(productionUrlFromSiteSlug(undefined)).toBeNull();
    expect(productionUrlFromSiteSlug("")).toBeNull();
    expect(productionUrlFromSiteSlug("   ")).toBeNull();
  });
});

describe("resolvePreviewDisplay", () => {
  it("shows the sandbox iframe once boot is done (running)", () => {
    expect(
      resolvePreviewDisplay({
        previewState: IFRAME,
        progressStatus: "done",
        productionUrl: PROD,
      }),
    ).toEqual({
      mode: "sandbox",
      iframeBase: IFRAME.kind === "iframe" ? IFRAME.previewUrl : null,
      showBlockingOverlay: false,
      showWakingPill: false,
    });
  });

  it("shows the sandbox iframe (crash page) on a failed boot, not production", () => {
    const result = resolvePreviewDisplay({
      previewState: IFRAME,
      progressStatus: "failed",
      productionUrl: PROD,
    });
    expect(result.mode).toBe("sandbox");
    expect(result.showWakingPill).toBe(false);
  });

  it("falls back to production + pill while a fresh boot is in progress", () => {
    expect(
      resolvePreviewDisplay({
        previewState: STARTING,
        progressStatus: "doing",
        productionUrl: PROD,
      }),
    ).toEqual({
      mode: "production",
      iframeBase: PROD,
      showBlockingOverlay: false,
      showWakingPill: true,
    });
  });

  it("falls back to production + pill while the sandbox iframe is still warming", () => {
    // previewUrl exists (kind === "iframe") but the dev server isn't up yet.
    const result = resolvePreviewDisplay({
      previewState: IFRAME,
      progressStatus: "doing",
      productionUrl: PROD,
    });
    expect(result.mode).toBe("production");
    expect(result.iframeBase).toBe(PROD);
    expect(result.showWakingPill).toBe(true);
  });

  it("keeps the blocking overlay while booting when there is no production URL", () => {
    expect(
      resolvePreviewDisplay({
        previewState: STARTING,
        progressStatus: "doing",
        productionUrl: null,
      }),
    ).toEqual({
      mode: "none",
      iframeBase: null,
      showBlockingOverlay: true,
      showWakingPill: false,
    });
  });

  it("keeps the blocking overlay for a warming iframe with no production URL", () => {
    const result = resolvePreviewDisplay({
      previewState: IFRAME,
      progressStatus: "doing",
      productionUrl: null,
    });
    expect(result.mode).toBe("none");
    expect(result.showBlockingOverlay).toBe(true);
  });

  it("yields the canvas to the suspended card (no overlay, no pill)", () => {
    expect(
      resolvePreviewDisplay({
        previewState: SUSPENDED,
        progressStatus: "doing",
        productionUrl: PROD,
      }),
    ).toEqual({
      mode: "none",
      iframeBase: null,
      showBlockingOverlay: false,
      showWakingPill: false,
    });
  });

  it("yields the canvas to the errored card (no overlay, no pill)", () => {
    expect(
      resolvePreviewDisplay({
        previewState: ERRORED,
        progressStatus: "failed",
        productionUrl: PROD,
      }),
    ).toEqual({
      mode: "none",
      iframeBase: null,
      showBlockingOverlay: false,
      showWakingPill: false,
    });
  });
});
