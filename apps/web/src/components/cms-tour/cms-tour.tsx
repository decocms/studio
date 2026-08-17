/**
 * CmsTour — the first-run coach-mark tour for the CMS (code agents).
 *
 * A spotlight walkthrough (driver.js) that dims the shell and highlights each
 * key control in turn: Preview, the views dropdown, the CMS (Blocks) editor,
 * the visual editor, the responsive device toggle, branches, submit-for-review
 * and publish. It fires once per user (persisted in localStorage) the first
 * time they land on a code agent with a live preview.
 *
 * driver.js runs imperatively OUTSIDE React (it measures element rects and
 * manages its own scroll/resize listeners), which is exactly why it fits here:
 * no `useEffect` (banned) is needed. We launch it from a derived-state guard —
 * the same "decide once during render" pattern used by LanguageAnnouncementDialog
 * — deferred through `queueMicrotask` so the imperative call lands after paint.
 * driver.js (+ its CSS) is loaded lazily via dynamic import so its ~8KB stays
 * out of the initial shell bundle for the users who never trigger the tour.
 */

import { useState } from "react";
import type { Config, Driver, DriveStep } from "driver.js";
import "driver.js/dist/driver.css";
import "./cms-tour.css";
import { authClient } from "@/lib/auth-client";
import { resolveCmsMode } from "@/sdk/cms-mode";
import { agentHasClonableSource } from "@/lib/agent-capabilities";
import { useSandboxEvents } from "@/components/sandbox/hooks/use-sandbox-events";
import { useVirtualMCP } from "@/sdk";
import { LOCALSTORAGE_KEYS } from "@/lib/localstorage-keys";
import { makeSeenFlag } from "@/lib/seen-flag";
import { useT, type TFunction } from "@/i18n/use-t";
import { tourAnchorSelector } from "./anchors";
import { buildSteps } from "./steps";

/** The tour waits for its lead control — the CMS toggle — to be on screen. */
const READY_SELECTOR = tourAnchorSelector("edit");

const seenFlag = (userId: string) =>
  makeSeenFlag(LOCALSTORAGE_KEYS.cmsTourSeen(userId));

/** An anchor counts only when it's in the DOM *and* actually visible (not
 *  display:none behind an inactive tab, not a zero-box collapsed control). */
function isAnchorOnScreen(selector: string): boolean {
  const el = document.querySelector(selector);
  return el instanceof HTMLElement && el.offsetParent !== null;
}

/**
 * Build the step list from only the anchors that are present AND visible right
 * now. This is what keeps a step from floating over an unrelated spot or
 * mis-highlighting a hidden control: absent controls (e.g. the branch pill on a
 * template with no connected repo) simply aren't steps, so the progress count
 * has no gaps either.
 */
function visibleSteps(t: TFunction): DriveStep[] {
  return buildSteps(t).filter(
    (step) =>
      typeof step.element === "string" && isAnchorOnScreen(step.element),
  );
}

function buildConfig(t: TFunction, steps: DriveStep[]): Config {
  return {
    showProgress: true,
    progressText: t("cmsTour.progress"),
    nextBtnText: t("cmsTour.next"),
    prevBtnText: t("cmsTour.prev"),
    doneBtnText: t("cmsTour.done"),
    // Drop the corner "close" icon; we inject a labelled "Skip" button into the
    // footer instead (see onPopoverRender). ESC / overlay-click still close.
    showButtons: ["next", "previous"],
    smoothScroll: true,
    allowClose: true,
    // Look-but-don't-touch: the highlighted control stays non-interactive so a
    // user can't click e.g. the Preview tab mid-tour, close the view, and strand
    // the remaining steps with no anchors. Navigation is Next / Back / Skip only.
    disableActiveInteraction: true,
    stagePadding: 6,
    stageRadius: 8,
    // Steps are pre-filtered to currently-visible anchors, so don't wait/float
    // for an element to appear; skip immediately if one vanishes mid-tour.
    waitForElement: 0,
    skipMissingElement: true,
    popoverClass: "cms-tour-popover",
    onPopoverRender: (popover, { driver: instance }) => {
      // driver.js has no footer "close" button, so add one that reads "Skip"
      // and matches the nav buttons. Guard against re-runs (resize/refresh
      // re-invoke this hook on the same popover DOM).
      if (popover.footerButtons.querySelector(".cms-tour-skip")) return;
      const skip = document.createElement("button");
      skip.type = "button";
      skip.className = "driver-popover-footer-btn cms-tour-skip";
      skip.textContent = t("cmsTour.skip");
      skip.addEventListener("click", () => instance.destroy());
      popover.footerButtons.insertBefore(
        skip,
        popover.footerButtons.firstChild,
      );
    },
    // Release the singleton guard when the tour ends (skip / done / esc) so a
    // manual re-run from the ⋯ menu can start a fresh one.
    onDestroyed: () => {
      tourStarted = false;
    },
    steps,
  };
}

// Module-level singleton guard. driver.js appends ONE global overlay; two
// concurrent `.drive()` calls stack two overlays (≈opaque black background).
// The component's `useState` guard isn't enough — React StrictMode
// (mount→unmount→mount in dev) and shell remounts spin up fresh instances, each
// scheduling its own launch before the first marks the tour seen. This flag is
// the real gate: only the first caller drives.
let tourStarted = false;

/** Lazily pull the driver.js runtime (~7KB gz) off the initial shell bundle.
 *  Its small CSS is a static side-effect import above (dynamic CSS imports have
 *  no type), which is fine — the JS is the bulk of the weight. */
async function loadDriver(): Promise<(config?: Config) => Driver> {
  const mod = await import("driver.js");
  return mod.driver;
}

/**
 * Poll (bounded, via rAF) until the preview toolbar is on screen, then drive the
 * tour over the currently-visible anchors. `onStart` fires the moment we commit
 * to driving (used to mark the auto-run seen). If the toolbar never appears, no
 * anchor is visible, or driver.js fails to load / throws, we release the guard
 * so a later attempt (or the ⋯ re-run) can retry.
 */
function driveTour(t: TFunction, onStart?: () => void) {
  if (tourStarted) return;
  tourStarted = true;
  let frames = 0;
  const tryStart = () => {
    if (isAnchorOnScreen(READY_SELECTOR)) {
      const steps = visibleSteps(t);
      if (steps.length === 0) {
        tourStarted = false;
        return;
      }
      onStart?.();
      loadDriver()
        .then((driver) => {
          driver(buildConfig(t, steps)).drive();
        })
        .catch(() => {
          tourStarted = false;
        });
      return;
    }
    if (frames++ < 60) {
      requestAnimationFrame(tryStart);
    } else {
      tourStarted = false;
    }
  };
  tryStart();
}

/**
 * Manually (re)start the tour — wired to the "Visual tour" item in the preview
 * ⋯ menu. Always runs, regardless of the "seen" flag.
 */
export function startCmsTour(t: TFunction) {
  driveTour(t);
}

/**
 * Mounts inside the workspace shell (has the sandbox-events + virtual-MCP
 * context). Renders nothing; its only job is to launch the tour once when the
 * conditions are met.
 */
export function CmsTour({ virtualMcpId }: { virtualMcpId: string }) {
  const t = useT();
  const entity = useVirtualMCP(virtualMcpId);
  const vmEvents = useSandboxEvents();
  const { data: session } = authClient.useSession();
  const userId = session?.user?.id;

  const isCodeAgent = agentHasClonableSource(entity?.metadata);
  // CMS mode has no dev server to wait for — its surface is up immediately.
  const previewReady =
    resolveCmsMode(entity?.metadata).active ||
    vmEvents.lifecycle.phase === "running";
  const eligible = isCodeAgent && previewReady && !!userId;

  const [launched, setLaunched] = useState(false);
  if (!launched && eligible && userId && !seenFlag(userId).has()) {
    setLaunched(true);
    queueMicrotask(() => driveTour(t, () => seenFlag(userId).mark()));
  }

  return null;
}
