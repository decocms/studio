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
 *
 * Both modes share one shape: the published site holds the canvas until
 * something better is ready, then that swaps in. Fast Preview does not change
 * the surface, only *when* it's ready — its draft render needs the daemon alone
 * (up shortly after the clone), where the normal path waits out install + dev
 * server. So the blocking overlay is only for projects with no production URL
 * at all; Fast Preview requires one, so it never reaches that branch.
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
  /**
   * Fast Preview is on (its switch is enabled AND a production URL is set).
   * Fast Preview does not change the *surface* — it changes when the surface is
   * ready. Both modes paint the published site while the sandbox boots; Fast
   * Preview swaps in the daemon's draft render (ready after the clone) where the
   * normal path waits for the dev server (ready at `running`).
   */
  fastPreviewActive?: boolean;
  /**
   * The caller could actually build the draft URL — it has the sandbox handle
   * and a draft version. Only meaningful with `fastPreviewActive`. False means
   * the draft isn't addressable yet, so the published site keeps the canvas
   * (with the waking pill) instead.
   */
  fastPreviewReady?: boolean;
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
  const {
    previewState,
    progressStatus,
    productionUrl,
    foreignSandbox,
    // Optional like `foreignSandbox`: a caller that knows nothing about Fast
    // Preview gets exactly the pre-existing behaviour.
    fastPreviewActive = false,
    fastPreviewReady = false,
  } = input;

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

  // Fast Preview's draft render, the moment it's renderable. It needs only the
  // daemon (up shortly after the clone), so this deliberately ignores
  // `progressStatus` — waiting for the dev server is the whole cost it exists to
  // skip. `iframeBase` stays the PUBLISHED url: the caller layers the draft URL
  // over it, so every production-mode base is a page we can actually navigate to
  // (and the URL-bar label doesn't jump between origins mid-boot).
  if (fastPreviewActive && fastPreviewReady && productionUrl) {
    return {
      mode: "production",
      iframeBase: productionUrl,
      showBlockingOverlay: false,
      showWakingPill: false,
    };
  }

  // The sandbox surface is showable once a previewUrl exists AND boot is no
  // longer in progress: `done` (running) serves the live app, `failed`/`crashed`
  // serves the daemon's auto-reloading status page — both belong in the iframe,
  // not behind a "waking" pill. Two independent bypasses meet here: Fast
  // Preview skips this branch entirely (its draft render above owns the canvas
  // instead of the dev server), and a foreign sandbox skips the progress gate
  // (its progress is unobservable — see `foreignSandbox`), so whatever the
  // owner's daemon serves is the displayed state.
  if (
    !fastPreviewActive &&
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

  // Nothing better is ready yet — paint the published site + a "waking" pill.
  // Shared by both modes: Fast Preview holds here until the daemon can render
  // the draft, the normal path until the dev server is routable. Fast Preview
  // guarantees a `productionUrl` (its gate requires one), so it always lands
  // here rather than on the blocking overlay below.
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
