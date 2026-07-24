/**
 * Pure preview-display decision — layered on top of `computePreviewState`.
 *
 * `computePreviewState` decides *what the sandbox is doing* (starting /
 * suspended / errored / iframe). This layer decides *what to paint in the
 * canvas while it boots*: instead of a blocking overlay, a deco.cx project can
 * show its live production site (Lovable-style) plus a non-blocking "waking"
 * pill, then swap the iframe to the sandbox preview once the dev server is up.
 *
 * The sandbox preview base (`previewState.previewUrl`) flips to `iframe` as soon
 * as the sandbox handle exists — well before the dev server is routable — so we
 * gate the sandbox surface on `progressStatus` (boot no longer in progress),
 * NOT on the mere existence of `previewUrl`.
 */

import type { PreviewState } from "./preview-state";
import type { PhaseStatus } from "./derive-phase-progress";

/** Which surface the preview canvas should render. */
export type PreviewDisplayMode =
  /** Sandbox dev-server iframe (or the daemon's crash/status page). */
  | "sandbox"
  /** Live production site while the sandbox is still waking. */
  | "production"
  /** No iframe — a dedicated overlay (booting/suspended/errored) owns the canvas. */
  | "none";

export interface PreviewDisplay {
  mode: PreviewDisplayMode;
  /** Base URL for the iframe, or `null` when `mode === "none"`. */
  iframeBase: string | null;
  /** The full-canvas booting card (today's behavior when there's no fallback). */
  showBlockingOverlay: boolean;
  /** Non-blocking "server waking — showing published site" pill. */
  showWakingPill: boolean;
}

export interface PreviewDisplayInput {
  previewState: PreviewState;
  /** Current boot step status (`derivePhaseProgress(...).status`). */
  progressStatus: PhaseStatus;
  /** Live production URL to fall back to while waking, or `null` if unknown. */
  productionUrl: string | null;
  /**
   * Fast Preview is on (its switch is enabled AND a production URL is set). When
   * true the `production` surface renders the actual working-tree draft (via
   * `/live/previews`), so it IS the preview — not a published-site stopgap. That
   * changes what the "waking" pill tracks: only the *sandbox* coming up (no
   * handle yet), NOT the dev server inside it finishing (install/start). When
   * false, the pill stays up until the dev server is routable, since the
   * production surface is only the published fallback.
   */
  fastPreviewActive: boolean;
}

const NONE: PreviewDisplay = {
  mode: "none",
  iframeBase: null,
  showBlockingOverlay: false,
  showWakingPill: false,
};

export function resolvePreviewDisplay(
  input: PreviewDisplayInput,
): PreviewDisplay {
  const { previewState, progressStatus, productionUrl, fastPreviewActive } =
    input;

  // Suspended / errored / othersThread all render their own dedicated card
  // (the last one is a confirmation gate on a teammate's branch) — hand the
  // canvas over so we don't paint a toolbar or load the production iframe
  // behind/around it.
  if (
    previewState.kind === "suspended" ||
    previewState.kind === "errored" ||
    previewState.kind === "othersThread"
  ) {
    return NONE;
  }

  // The sandbox surface is showable once a previewUrl exists AND boot is no
  // longer in progress: `done` (running) serves the live app, `failed`/`crashed`
  // serves the daemon's auto-reloading status page — both belong in the iframe,
  // not behind a "waking" pill.
  //
  // Fast Preview NEVER uses the sandbox for previewing: it renders everything on
  // the preview server (via `/live/previews`), so we skip this swap entirely and
  // stay on the `production` branch below for the whole lifecycle — even once the
  // dev server is up. (We still wait for the sandbox *itself* — the FS/handle —
  // because content is read from its `blocks.gen.json`; that's the pill below.)
  if (
    !fastPreviewActive &&
    previewState.kind === "iframe" &&
    progressStatus !== "doing"
  ) {
    return {
      mode: "sandbox",
      iframeBase: previewState.previewUrl,
      showBlockingOverlay: false,
      showWakingPill: false,
    };
  }

  // Show the preview server. Two modes converge here:
  //  - Fast Preview ON: this is the *only* surface — the preview server renders
  //    the draft via `/live/previews` for the whole session; no swap to sandbox.
  //    The pill tracks only the sandbox *itself* coming up (handle exists), since
  //    once the FS is readable the draft can render; the dev server is irrelevant.
  //  - Fast Preview OFF: this is a temporary stopgap (the published site) shown
  //    while the sandbox boots; the pill stays up until the dev server is routable
  //    and the `sandbox` swap above takes over.
  if (productionUrl) {
    const sandboxUp = previewState.kind === "iframe";
    return {
      mode: "production",
      iframeBase: productionUrl,
      showBlockingOverlay: false,
      showWakingPill: fastPreviewActive ? !sandboxUp : true,
    };
  }

  // No fallback available (e.g. a GitHub-only project, or a site imported
  // before productionUrl was persisted): keep the original blocking overlay.
  return {
    mode: "none",
    iframeBase: null,
    showBlockingOverlay: true,
    showWakingPill: false,
  };
}
