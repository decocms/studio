/**
 * CmsTour — the first-run coach-mark tour for the CMS (code agents).
 *
 * A spotlight walkthrough (driver.js) that dims the shell and highlights each
 * key control in turn: Preview, Edit, the Visual editor, the responsive Device
 * toggle, and the Branch selector. It fires once per user (persisted in
 * localStorage) the first time they land on a code agent with a live preview.
 *
 * driver.js runs imperatively OUTSIDE React (it measures element rects and
 * manages its own scroll/resize listeners), which is exactly why it fits here:
 * no `useEffect` (banned) is needed. We launch it from a derived-state guard —
 * the same "decide once during render" pattern used by LanguageAnnouncementDialog
 * — deferred through `queueMicrotask` so the imperative call lands after paint.
 */

import { useState } from "react";
import { driver } from "driver.js";
import type { Config, DriveStep } from "driver.js";
import "driver.js/dist/driver.css";
import "./cms-tour.css";
import { authClient } from "@/web/lib/auth-client";
import { agentHasClonableSource } from "@/web/lib/agent-capabilities";
import { useSandboxEvents } from "@/web/components/sandbox/hooks/use-sandbox-events";
import { useVirtualMCP } from "@decocms/mesh-sdk";
import { LOCALSTORAGE_KEYS } from "@/web/lib/localstorage-keys";
import { useT, type TFunction } from "@/web/i18n/use-t";

/** The lead anchor — the tour only starts once the Preview tab is on screen. */
const PREVIEW_SELECTOR = '[data-tour="tour-tab-preview"]';

type StepDef = {
  selector: string;
  titleKey: Parameters<TFunction>[0];
  descKey: Parameters<TFunction>[0];
  side: NonNullable<DriveStep["popover"]>["side"];
};

// Ordered by the natural editing flow: see the site → edit it → edit visually →
// check it responsively → manage where the changes live. Anchors that aren't on
// screen (e.g. the branch pill on a template with no connected repo) are skipped
// automatically via `skipMissingElement`.
const STEP_DEFS: StepDef[] = [
  {
    selector: PREVIEW_SELECTOR,
    titleKey: "cmsTour.preview.title",
    descKey: "cmsTour.preview.description",
    side: "bottom",
  },
  {
    selector: '[data-tour="tour-dropdown"]',
    titleKey: "cmsTour.dropdown.title",
    descKey: "cmsTour.dropdown.description",
    side: "bottom",
  },
  {
    selector: '[data-tour="tour-edit"]',
    titleKey: "cmsTour.edit.title",
    descKey: "cmsTour.edit.description",
    side: "bottom",
  },
  {
    selector: '[data-tour="tour-visual-editor"]',
    titleKey: "cmsTour.visualEditor.title",
    descKey: "cmsTour.visualEditor.description",
    side: "top",
  },
  {
    selector: '[data-tour="tour-device"]',
    titleKey: "cmsTour.device.title",
    descKey: "cmsTour.device.description",
    side: "top",
  },
  {
    selector: '[data-tour="tour-branches"]',
    titleKey: "cmsTour.branches.title",
    descKey: "cmsTour.branches.description",
    side: "bottom",
  },
  {
    selector: '[data-tour="tour-submit"]',
    titleKey: "cmsTour.submit.title",
    descKey: "cmsTour.submit.description",
    side: "bottom",
  },
  {
    selector: '[data-tour="tour-publish"]',
    titleKey: "cmsTour.publish.title",
    descKey: "cmsTour.publish.description",
    side: "bottom",
  },
];

function hasSeenTour(userId: string): boolean {
  try {
    return localStorage.getItem(LOCALSTORAGE_KEYS.cmsTourSeen(userId)) === "1";
  } catch {
    return false;
  }
}

function markTourSeen(userId: string) {
  try {
    localStorage.setItem(LOCALSTORAGE_KEYS.cmsTourSeen(userId), "1");
  } catch {}
}

function buildSteps(t: TFunction): DriveStep[] {
  return STEP_DEFS.map((step) => ({
    element: step.selector,
    popover: {
      title: t(step.titleKey),
      description: t(step.descKey),
      side: step.side,
      align: "center",
    },
  }));
}

function buildConfig(t: TFunction): Config {
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
    stagePadding: 6,
    stageRadius: 8,
    // Anchors live across two panels and some appear only once the preview is
    // live; wait briefly for each and skip any that never show.
    waitForElement: 2000,
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
    steps: buildSteps(t),
  };
}

// Module-level singleton guard. driver.js appends ONE global overlay; two
// concurrent `.drive()` calls stack two overlays (≈opaque black background).
// The component's `useState` guard isn't enough — React StrictMode
// (mount→unmount→mount in dev) and shell remounts spin up fresh instances, each
// scheduling its own launch before the first marks the tour seen. This flag is
// the real gate: only the first caller drives.
let tourStarted = false;

/**
 * Poll (bounded, via rAF) until the Preview anchor is mounted, then drive the
 * tour. `onStart` fires the moment we commit to driving (used to mark the
 * auto-run seen). If the anchor never appears we release the guard so a later
 * attempt can retry.
 */
function driveTour(t: TFunction, onStart?: () => void) {
  if (tourStarted) return;
  tourStarted = true;
  let frames = 0;
  const tryStart = () => {
    if (document.querySelector(PREVIEW_SELECTOR)) {
      onStart?.();
      driver(buildConfig(t)).drive();
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
  const previewReady = vmEvents.lifecycle.phase === "running";
  const eligible = isCodeAgent && previewReady && !!userId;

  const [launched, setLaunched] = useState(false);
  if (!launched && eligible && userId && !hasSeenTour(userId)) {
    setLaunched(true);
    queueMicrotask(() => driveTour(t, () => markTourSeen(userId)));
  }

  return null;
}
