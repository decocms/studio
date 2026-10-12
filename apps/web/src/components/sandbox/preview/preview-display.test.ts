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
    previewServerUrl: PROD,
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

  describe("Local mode", () => {
    const LOCAL = "https://my-tunnel.example.com";

    it("renders the tunnel as a sandbox iframe immediately, ignoring boot gating", () => {
      expect(
        run({
          previewState: STARTING,
          progressStatus: "doing",
          localPreviewUrl: LOCAL,
        }),
      ).toEqual({
        mode: "sandbox",
        iframeBase: LOCAL,
        showBlockingOverlay: false,
        showWakingPill: false,
      });
    });

    it("wins over Fast Preview and suspended/errored lifecycle states", () => {
      for (const previewState of [IFRAME, SUSPENDED, ERRORED] as const) {
        const result = run({
          previewState,
          fastPreviewActive: true,
          fastPreviewReady: true,
          localPreviewUrl: LOCAL,
        });
        expect(result.mode).toBe("sandbox");
        expect(result.iframeBase).toBe(LOCAL);
      }
    });
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
        previewServerUrl: null,
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
      previewServerUrl: null,
    });
    expect(result.mode).toBe("none");
    expect(result.showBlockingOverlay).toBe(true);
  });

  describe("codingSession", () => {
    it("keeps the published-site fallback for a CMS session with a preview URL", () => {
      const result = run({ codingSession: false });
      expect(result.mode).toBe("production");
      expect(result.showWakingPill).toBe(true);
      expect(result.showBlockingOverlay).toBe(false);
    });

    it("withholds the fallback so a coding session boots visibly", () => {
      const result = run({ codingSession: true });
      expect(result.mode).toBe("none");
      expect(result.showBlockingOverlay).toBe(true);
      expect(result.showWakingPill).toBe(false);
    });

    it("still hands a booted coding session its sandbox iframe", () => {
      const result = run({
        previewState: IFRAME,
        progressStatus: "done",
        codingSession: true,
      });
      expect(result.mode).toBe("sandbox");
    });
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

    it("shows the published site + pill while the draft round-trip is in flight", () => {
      // The published site holds the canvas and the pill says a fresher
      // render is on its way — the draft URL needs one server round-trip
      // (version + signed token) before it is addressable.
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

    it("holds the published site when the draft URL isn't buildable yet", () => {
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

  describe("hosted draft (Blocks v8, no sandbox)", () => {
    it("shows the published site with no pill before the first edit", () => {
      // Nothing boots on a hosted v8 session: "not ready" only means no
      // draft exists yet, so the published site is the preview.
      expect(
        run({
          previewState: STARTING,
          progressStatus: "doing",
          fastPreviewActive: true,
          fastPreviewReady: false,
          hostedDraft: true,
        }),
      ).toEqual({
        mode: "production",
        iframeBase: PROD,
        showBlockingOverlay: false,
        showWakingPill: false,
      });
    });

    it("shows the draft once the first edit creates one, as before", () => {
      expect(
        run({
          previewState: STARTING,
          progressStatus: "doing",
          fastPreviewActive: true,
          fastPreviewReady: true,
          hostedDraft: true,
        }),
      ).toEqual({
        mode: "production",
        iframeBase: PROD,
        showBlockingOverlay: false,
        showWakingPill: false,
      });
    });

    it("never paints the pill whatever the (absent) sandbox reports", () => {
      for (const previewState of [STARTING, IFRAME]) {
        for (const progressStatus of ["doing", "done", "failed"] as const) {
          const result = run({
            previewState,
            progressStatus,
            fastPreviewActive: true,
            hostedDraft: true,
          });
          expect(result.mode).toBe("production");
          expect(result.showWakingPill).toBe(false);
        }
      }
    });

    it("is ignored outside Fast Preview (a sandbox session boots visibly)", () => {
      const result = run({
        previewState: STARTING,
        progressStatus: "doing",
        fastPreviewActive: false,
        hostedDraft: true,
      });
      expect(result.showWakingPill).toBe(true);
    });

    it("leaves a v7 Fast Preview's pill exactly as before", () => {
      const result = run({
        previewState: STARTING,
        progressStatus: "doing",
        fastPreviewActive: true,
        fastPreviewReady: false,
        hostedDraft: false,
      });
      expect(result.showWakingPill).toBe(true);
    });

    it("still yields to Local mode and to a suspended sandbox", () => {
      expect(
        run({
          fastPreviewActive: true,
          hostedDraft: true,
          localPreviewUrl: "http://localhost:8000",
        }).mode,
      ).toBe("sandbox");
      expect(
        run({
          previewState: SUSPENDED,
          fastPreviewActive: true,
          hostedDraft: true,
        }).mode,
      ).toBe("none");
    });
  });
});

describe("deciding v7 or v8 (GitHub mode while main's answer loads)", () => {
  // GitHub mode: Fast Preview on, nothing booting, the hosted draft only
  // once main is known to be v8.
  const github = (
    main: "loading" | "error" | "v8" | "v7",
  ): Partial<PreviewDisplayInput> => ({
    fastPreviewActive: true,
    fastPreviewReady: false,
    deciding: main === "loading" || main === "error",
    hostedDraft: main === "v8",
  });

  it("main loading, then v8: never a waking pill, never the v7 surface first", () => {
    const steps = (["loading", "error", "v8"] as const).map((main) =>
      run(github(main)),
    );
    expect(steps.some((d) => d.showWakingPill)).toBe(false);
    expect(steps.slice(0, 2).every((d) => d.mode === "none")).toBe(true);
    expect(steps.slice(0, 2).every((d) => d.showDecidingLoader)).toBe(true);
    expect(steps.at(-1)).toMatchObject({
      mode: "production",
      iframeBase: PROD,
    });
  });

  it("main loading, then v7: a neutral loader, then the v7 surface as on main", () => {
    const [deciding, v7] = (["loading", "v7"] as const).map((main) =>
      run(github(main)),
    );
    expect(deciding).toMatchObject({
      mode: "none",
      showBlockingOverlay: false,
      showWakingPill: false,
      showDecidingLoader: true,
    });
    expect(v7).toEqual(run({ fastPreviewActive: true }));
  });

  it("a saved Local tunnel waiting for main: no boot card, no tunnel, then the tunnel (v7)", () => {
    const tunnel = "https://my-tunnel.example.com";
    const deciding = run({ deciding: true, localPreviewUrl: null });
    expect(deciding.showBlockingOverlay).toBe(false);
    expect(deciding.iframeBase).toBeNull();
    expect(run({ localPreviewUrl: tunnel })).toMatchObject({
      mode: "sandbox",
      iframeBase: tunnel,
    });
  });
});
