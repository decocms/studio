import { describe, expect, it } from "bun:test";
import {
  type PreviewDisplayInput,
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

const PROD = "https://acme.com";

// Fast Preview off is the default for the pre-existing behavior cases; each test
// overrides what it exercises.
function run(overrides: Partial<PreviewDisplayInput>) {
  return resolvePreviewDisplay({
    previewState: STARTING,
    progressStatus: "doing",
    productionUrl: PROD,
    fastPreviewActive: false,
    fastPreviewReady: false,
    ...overrides,
  });
}

describe("resolvePreviewDisplay", () => {
  it("shows the sandbox iframe once boot is done (running)", () => {
    expect(run({ previewState: IFRAME, progressStatus: "done" })).toEqual({
      mode: "sandbox",
      iframeBase: IFRAME.kind === "iframe" ? IFRAME.previewUrl : null,
      showBlockingOverlay: false,
      showWakingPill: false,
    });
  });

  it("shows the sandbox iframe (crash page) on a failed boot, not production", () => {
    const result = run({ previewState: IFRAME, progressStatus: "failed" });
    expect(result.mode).toBe("sandbox");
    expect(result.showWakingPill).toBe(false);
  });

  it("falls back to production + pill while a fresh boot is in progress", () => {
    expect(run({ previewState: STARTING, progressStatus: "doing" })).toEqual({
      mode: "production",
      iframeBase: PROD,
      showBlockingOverlay: false,
      showWakingPill: true,
    });
  });

  it("falls back to production + pill while the sandbox iframe is still warming (Fast Preview off)", () => {
    // previewUrl exists (kind === "iframe") but the dev server isn't up yet.
    // With Fast Preview off the production surface is the published stopgap, so
    // the pill stays up until the dev server is routable.
    const result = run({ previewState: IFRAME, progressStatus: "doing" });
    expect(result.mode).toBe("production");
    expect(result.iframeBase).toBe(PROD);
    expect(result.showWakingPill).toBe(true);
  });

  it("keeps the blocking overlay while booting when there is no production URL", () => {
    expect(
      run({
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
    const result = run({
      previewState: IFRAME,
      progressStatus: "doing",
      productionUrl: null,
    });
    expect(result.mode).toBe("none");
    expect(result.showBlockingOverlay).toBe(true);
  });

  it("yields the canvas to the suspended card (no overlay, no pill)", () => {
    expect(run({ previewState: SUSPENDED, progressStatus: "doing" })).toEqual({
      mode: "none",
      iframeBase: null,
      showBlockingOverlay: false,
      showWakingPill: false,
    });
  });

  it("yields the canvas to the errored card (no overlay, no pill)", () => {
    expect(run({ previewState: ERRORED, progressStatus: "failed" })).toEqual({
      mode: "none",
      iframeBase: null,
      showBlockingOverlay: false,
      showWakingPill: false,
    });
  });

  describe("Fast Preview", () => {
    it("drops the pill once the draft render is ready, still based on production", () => {
      // `iframeBase` stays the PUBLISHED url — the caller layers the daemon
      // draft URL over it, so the base is always navigable and the URL-bar
      // label doesn't jump origins when the draft swaps in.
      expect(
        run({
          previewState: IFRAME,
          progressStatus: "doing",
          fastPreviewActive: true,
          fastPreviewReady: true,
        }),
      ).toEqual({
        mode: "production",
        iframeBase: PROD,
        showBlockingOverlay: false,
        showWakingPill: false,
      });
    });

    it("shows the published site + pill while the sandbox provisions", () => {
      // Inverted from the original rule (blocking overlay, never the published
      // site). Boot should be invisible: the published site holds the canvas
      // until the draft render is renderable.
      expect(
        run({
          previewState: STARTING,
          progressStatus: "doing",
          fastPreviewActive: true,
          fastPreviewReady: false,
        }),
      ).toEqual({
        mode: "production",
        iframeBase: PROD,
        showBlockingOverlay: false,
        showWakingPill: true,
      });
    });

    it("holds the published site when the daemon is up but no page matched yet", () => {
      // previewUrl exists, but the decofile hasn't yielded a page key, so the
      // draft URL isn't buildable. Keep the pill rather than blanking.
      const result = run({
        previewState: IFRAME,
        progressStatus: "doing",
        fastPreviewActive: true,
        fastPreviewReady: false,
      });
      expect(result.mode).toBe("production");
      expect(result.iframeBase).toBe(PROD);
      expect(result.showWakingPill).toBe(true);
    });

    it("never swaps to the sandbox — the draft render owns the canvas regardless of dev-server state", () => {
      for (const progressStatus of ["done", "failed"] as const) {
        const result = run({
          previewState: IFRAME,
          progressStatus,
          fastPreviewActive: true,
          fastPreviewReady: true,
        });
        expect(result.mode).toBe("production");
        expect(result.iframeBase).toBe(PROD);
      }
    });

    it("does not fall through to the sandbox while waiting for the draft", () => {
      // Even with the dev server up, Fast Preview must not hand the canvas to
      // the sandbox iframe — that's the surface it deliberately replaces.
      const result = run({
        previewState: IFRAME,
        progressStatus: "done",
        fastPreviewActive: true,
        fastPreviewReady: false,
      });
      expect(result.mode).toBe("production");
      expect(result.showWakingPill).toBe(true);
    });
  });
});
