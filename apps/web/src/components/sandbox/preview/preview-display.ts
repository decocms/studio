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
   * The resolved sandbox belongs to ANOTHER member (a read-only view of their
   * thread's already-running sandbox — see the owner graft in `VmEventsBridge`).
   * Their boot progress is unobservable from here: the claim-phase / daemon
   * lifecycle stream is keyed to the VIEWER's claim handle, which never
   * materializes, so `progressStatus` is pinned at `doing` forever. Show the
   * iframe on `previewUrl` alone instead of waiting out a boot that isn't ours
   * to watch.
   */
  foreignSandbox?: boolean;
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
  const { previewState, progressStatus, productionUrl, foreignSandbox } = input;

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
  // not behind a "waking" pill. A foreign sandbox skips the progress gate (its
  // progress is unobservable — see `foreignSandbox`); whatever the owner's
  // daemon serves is the displayed state.
  if (
    previewState.kind === "iframe" &&
    (foreignSandbox || progressStatus !== "doing")
  ) {
    return {
      mode: "sandbox",
      iframeBase: previewState.previewUrl,
      showBlockingOverlay: false,
      showWakingPill: false,
    };
  }

  // Still booting (fresh boot with no previewUrl yet, or a warming iframe).
  // Prefer the live production site so the user sees their site immediately.
  if (productionUrl) {
    return {
      mode: "production",
      iframeBase: productionUrl,
      showBlockingOverlay: false,
      showWakingPill: true,
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
