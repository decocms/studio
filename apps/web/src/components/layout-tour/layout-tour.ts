/** LayoutTour — the guided walkthrough of the new workspace layout.
 *
 * A spotlight walkthrough (driver.js) that dims the shell and explains THE
 * SCREEN THE USER IS ON. It does not navigate: being yanked to the org home to
 * be shown around is worse than being told about the room you are standing in,
 * and it also throws away whatever you were doing. So the tour always covers
 * the shell (switcher, nav, Tasks, account) and then adds whatever the current
 * route can actually show — see `StepScope`.
 *
 * It is launched on demand from the release announcement card's CTA — never
 * automatically — so there is no "seen" flag here: the card already has one.
 *
 * driver.js runs imperatively OUTSIDE React (it measures element rects and
 * manages its own scroll/resize listeners), so the whole tour is a plain
 * function call with no component and no `useEffect` (banned). driver.js (+ its
 * CSS) is loaded lazily via dynamic import so its weight stays out of the
 * initial shell bundle for everyone who never starts the tour.
 */

import type { Config, Driver, DriveStep } from "driver.js";
import "driver.js/dist/driver.css";
import "./layout-tour.css";
import type { TFunction } from "@/i18n/use-t";
import { layoutTourAnchorSelector } from "./anchors";
import { buildSteps, type TourRoute } from "./steps";

/**
 * The tour starts in place, so the only anchor worth waiting for is the one
 * that is on every route anyway. This covers the frames between the CTA's
 * click and the sidebar settling — nothing more, because there is no
 * navigation to wait out any more.
 */
const READY_SELECTOR = layoutTourAnchorSelector("switcher");

/** ~0.5s at 60fps. Exceeding it is not a failure: `visibleSteps` still filters
 *  to whatever is actually painted, and an empty result just aborts. */
const READY_FRAME_BUDGET = 30;

/** An anchor counts only when it's in the DOM *and* actually visible (not
 *  display:none behind an inactive tab, not a zero-box collapsed control). */
function isAnchorOnScreen(selector: string): boolean {
  const el = document.querySelector(selector);
  return el instanceof HTMLElement && el.offsetParent !== null;
}

/**
 * Build the step list from only the anchors that are present AND visible right
 * now. Two filters stack: `stepsForRoute` drops steps that do not BELONG on
 * this screen, and this one drops steps whose control is not painted (the
 * activity column on an empty board, a branch picker on an agent with no repo).
 * Between them a step never floats over an unrelated spot, and the progress
 * count has no gaps.
 */
function visibleSteps(t: TFunction, route: TourRoute): DriveStep[] {
  return buildSteps(t, route).filter(
    (step) =>
      typeof step.element === "string" && isAnchorOnScreen(step.element),
  );
}

function buildConfig(t: TFunction, steps: DriveStep[]): Config {
  return {
    showProgress: true,
    progressText: t("layoutTour.progress"),
    nextBtnText: t("layoutTour.next"),
    prevBtnText: t("layoutTour.prev"),
    doneBtnText: t("layoutTour.done"),
    /** No corner "close": a labelled Skip goes in the footer (onPopoverRender);
     *  ESC and overlay-click still work. */
    showButtons: ["next", "previous"],
    smoothScroll: true,
    allowClose: true,
    /** The highlighted control stays non-interactive: opening the switcher
     *  mid-tour would strand the remaining steps behind a popover. */
    disableActiveInteraction: true,
    stagePadding: 6,
    stageRadius: 8,
    /** Steps are pre-filtered to visible anchors, so never wait for one —
     *  skip immediately if it vanishes mid-tour. */
    waitForElement: 0,
    skipMissingElement: true,
    popoverClass: "layout-tour-popover",
    onPopoverRender: (popover, { driver: instance }) => {
      /** driver.js has no footer close, so inject a "Skip" matching the nav
       *  buttons — guarded, since resize/refresh re-invoke this hook. */
      if (popover.footerButtons.querySelector(".layout-tour-skip")) return;
      const skip = document.createElement("button");
      skip.type = "button";
      skip.className = "driver-popover-footer-btn layout-tour-skip";
      skip.textContent = t("layoutTour.skip");
      skip.addEventListener("click", () => instance.destroy());
      popover.footerButtons.insertBefore(
        skip,
        popover.footerButtons.firstChild,
      );
    },
    /** Release the guard on any exit, so the CTA can start a fresh tour. */
    onDestroyed: () => {
      tourStarted = false;
    },
    steps,
  };
}

/** Singleton guard: driver.js appends ONE global overlay, so two concurrent
 *  `.drive()` calls stack them into a near-opaque background — which is exactly
 *  what double-clicking the release CTA does. The flag is the gate, not the
 *  caller. */
let tourStarted = false;

/** Lazily pull the driver.js runtime (~7KB gz) off the initial shell bundle.
 *  Its small CSS is a static side-effect import above (dynamic CSS imports have
 *  no type), which is fine — the JS is the bulk of the weight. */
async function loadDriver(): Promise<(config?: Config) => Driver> {
  const mod = await import("driver.js");
  return mod.driver;
}

/**
 * Start the layout tour over the CURRENT screen. `route` says which surfaces
 * this screen has, so the caller — which is the one with router access —
 * decides that rather than this module sniffing the DOM for it. If no anchor
 * is visible at all, or driver.js fails to load, the guard is released so a
 * later attempt can retry.
 */
export function startLayoutTour(t: TFunction, route: TourRoute) {
  if (tourStarted) return;
  tourStarted = true;
  let frames = 0;
  const tryStart = () => {
    if (!isAnchorOnScreen(READY_SELECTOR) && frames++ < READY_FRAME_BUDGET) {
      requestAnimationFrame(tryStart);
      return;
    }
    const steps = visibleSteps(t, route);
    if (steps.length === 0) {
      tourStarted = false;
      return;
    }
    loadDriver()
      .then((driver) => {
        driver(buildConfig(t, steps)).drive();
      })
      .catch(() => {
        tourStarted = false;
      });
  };
  tryStart();
}
