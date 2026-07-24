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
const OTHERS_THREAD: PreviewState = { kind: "othersThread", label: "Alice" };

const PROD = "https://acme.com";

// Fast Preview off is the default for the pre-existing behavior cases; each test
// overrides what it exercises.
function run(overrides: Partial<PreviewDisplayInput>) {
  return resolvePreviewDisplay({
    previewState: STARTING,
    progressStatus: "doing",
    productionUrl: PROD,
    fastPreviewActive: false,
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

  it("shows a foreign sandbox's iframe immediately — its boot is unobservable", () => {
    // Viewing a teammate's thread: previewUrl is their running sandbox, but the
    // claim/lifecycle stream is keyed to OUR handle so progressStatus never
    // leaves "doing". Without the foreignSandbox bypass this pins the blocking
    // overlay ("Reserving sandbox") forever.
    const result = resolvePreviewDisplay({
      previewState: IFRAME,
      progressStatus: "doing",
      productionUrl: null,
      foreignSandbox: true,
    });
    expect(result.mode).toBe("sandbox");
    expect(result.iframeBase).toBe(
      IFRAME.kind === "iframe" ? IFRAME.previewUrl : null,
    );
    expect(result.showBlockingOverlay).toBe(false);
  });

  it("prefers a foreign sandbox over the production fallback", () => {
    const result = resolvePreviewDisplay({
      previewState: IFRAME,
      progressStatus: "doing",
      productionUrl: PROD,
      foreignSandbox: true,
    });
    expect(result.mode).toBe("sandbox");
    expect(result.showWakingPill).toBe(false);
  });

  it("foreignSandbox does not override the othersThread gate or a bare start", () => {
    // No previewUrl yet → still the gate / booting path; the bypass only applies
    // to an already-resolved foreign previewUrl.
    expect(
      resolvePreviewDisplay({
        previewState: OTHERS_THREAD,
        progressStatus: "doing",
        productionUrl: PROD,
        foreignSandbox: true,
      }).mode,
    ).toBe("none");
    expect(
      resolvePreviewDisplay({
        previewState: STARTING,
        progressStatus: "doing",
        productionUrl: null,
        foreignSandbox: true,
      }).showBlockingOverlay,
    ).toBe(true);
  });

  it("yields the canvas to the othersThread gate — no production leak", () => {
    // A teammate's branch: even with a productionUrl set, don't paint a toolbar
    // or load the production iframe behind the confirmation card.
    expect(
      run({ previewState: OTHERS_THREAD, progressStatus: "doing" }),
    ).toEqual({
      mode: "none",
      iframeBase: null,
      showBlockingOverlay: false,
      showWakingPill: false,
    });
  });

  describe("Fast Preview", () => {
    const previewUrl = IFRAME.kind === "iframe" ? IFRAME.previewUrl : "";

    it("renders on the daemon (previewUrl), never the published site", () => {
      const result = run({
        previewState: IFRAME,
        progressStatus: "doing",
        fastPreviewActive: true,
      });
      expect(result.mode).toBe("production");
      // The daemon origin, NOT productionUrl — Fast Preview never shows the
      // published site.
      expect(result.iframeBase).toBe(previewUrl);
      expect(result.iframeBase).not.toBe(PROD);
      expect(result.showWakingPill).toBe(false);
    });

    it("shows a booting overlay (not the published site) while the sandbox provisions", () => {
      // No previewUrl yet → the daemon can't serve the render; show the overlay,
      // never fall back to productionUrl.
      expect(
        run({
          previewState: STARTING,
          progressStatus: "doing",
          fastPreviewActive: true,
        }),
      ).toEqual({
        mode: "none",
        iframeBase: null,
        showBlockingOverlay: true,
        showWakingPill: false,
      });
    });

    it("never swaps to the sandbox — stays on the daemon render regardless of dev-server state", () => {
      for (const progressStatus of ["done", "failed"] as const) {
        const result = run({
          previewState: IFRAME,
          progressStatus,
          fastPreviewActive: true,
        });
        expect(result.mode).toBe("production");
        expect(result.iframeBase).toBe(previewUrl);
      }
    });
  });
});
