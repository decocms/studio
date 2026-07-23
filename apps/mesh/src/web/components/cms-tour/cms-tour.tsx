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
import type { Config, Driver } from "driver.js";
import "driver.js/dist/driver.css";
import "./cms-tour.css";
import { authClient } from "@/web/lib/auth-client";
import { agentHasClonableSource } from "@/web/lib/agent-capabilities";
import { useSandboxEvents } from "@/web/components/sandbox/hooks/use-sandbox-events";
import { useVirtualMCP } from "@decocms/mesh-sdk";
import { LOCALSTORAGE_KEYS } from "@/web/lib/localstorage-keys";
import { makeSeenFlag } from "@/web/lib/seen-flag";
import { useT, type TFunction } from "@/web/i18n/use-t";
import { tourAnchorSelector } from "./anchors";
import { buildSteps } from "./steps";

/**
 * The tour only starts once the Preview *content* is mounted (not merely the
 * Preview tab, which is always in the header). This keeps the auto-run from
 * firing a mostly-empty tour when another main view (e.g. Code) is active.
 */
const READY_SELECTOR = tourAnchorSelector("previewRoot");

const seenFlag = (userId: string) =>
  makeSeenFlag(LOCALSTORAGE_KEYS.cmsTourSeen(userId));

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

/** Lazily pull the driver.js runtime (~7KB gz) off the initial shell bundle.
 *  Its small CSS is a static side-effect import above (dynamic CSS imports have
 *  no type), which is fine — the JS is the bulk of the weight. */
async function loadDriver(): Promise<(config?: Config) => Driver> {
  const mod = await import("driver.js");
  return mod.driver;
}

/**
 * Poll (bounded, via rAF) until the Preview content is mounted, then drive the
 * tour. `onStart` fires the moment we commit to driving (used to mark the
 * auto-run seen). If the content never appears — or driver.js fails to load /
 * throws — we release the guard so a later attempt (or the ⋯ re-run) can retry.
 */
function driveTour(t: TFunction, onStart?: () => void) {
  if (tourStarted) return;
  tourStarted = true;
  let frames = 0;
  const tryStart = () => {
    if (document.querySelector(READY_SELECTOR)) {
      onStart?.();
      loadDriver()
        .then((driver) => {
          driver(buildConfig(t)).drive();
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
  const previewReady = vmEvents.lifecycle.phase === "running";
  const eligible = isCodeAgent && previewReady && !!userId;

  const [launched, setLaunched] = useState(false);
  if (!launched && eligible && userId && !seenFlag(userId).has()) {
    setLaunched(true);
    queueMicrotask(() => driveTour(t, () => seenFlag(userId).mark()));
  }

  return null;
}
