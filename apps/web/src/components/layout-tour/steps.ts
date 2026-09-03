import type { DriveStep } from "driver.js";
import type { TFunction } from "@/i18n/use-t";
import { LAYOUT_TOUR_ANCHORS, layoutTourAnchorSelector } from "./anchors";

type AnchorName = keyof typeof LAYOUT_TOUR_ANCHORS;

/**
 * Which routes a step belongs to.
 *
 * `shell` steps run wherever the tour is started from — they describe the
 * chrome that is always there. The other two describe a surface that only
 * exists somewhere, and are what lets the tour explain the screen the user is
 * ALREADY on instead of dragging them to the org home first.
 */
export type StepScope = "shell" | "orgHome" | "project" | "siteEditor";

/** Where the tour was started from. Both can be false (a settings or task
 *  route, say) — then only the `shell` steps run, which is the whole point of
 *  the scope split: a tour that explains the chrome is still worth running. */
export interface TourRoute {
  onOrgHome: boolean;
  inProject: boolean;
  /** The Site Editor surface (Preview / Content / Code) is open. A strict
   *  subset of `inProject`: the tab bar and the branch selector act on the
   *  surface being edited, and are mounted with it. */
  onSiteEditor: boolean;
}

export type StepDef = {
  scope: StepScope;
  anchor: AnchorName;
  titleKey: Parameters<TFunction>[0];
  descKey: Parameters<TFunction>[0];
  side: NonNullable<DriveStep["popover"]>["side"];
};

/**
 * ORDERED BY POSITION ON SCREEN, not by scope: down the sidebar from the
 * switcher at the top to the account button at its foot, and only then across
 * into the main panel. `stepsForRoute` preserves this order and merely drops
 * what does not apply, so every route gets a spotlight that walks the screen
 * instead of hopping around it — which is what a tour grouped by scope did,
 * jumping from the sidebar to the panel and back.
 *
 * A new step goes where its CONTROL sits, not next to steps of the same scope.
 * The sequence below is asserted in `steps.test.ts` for exactly that reason.
 */
export const STEP_DEFS: StepDef[] = [
  {
    scope: "shell",
    anchor: "switcher",
    titleKey: "layoutTour.switcher.title",
    descKey: "layoutTour.switcher.description",
    side: "right",
  },
  {
    scope: "shell",
    anchor: "nav",
    titleKey: "layoutTour.nav.title",
    descKey: "layoutTour.nav.description",
    side: "right",
  },
  {
    scope: "shell",
    anchor: "tasks",
    titleKey: "layoutTour.tasks.title",
    descKey: "layoutTour.tasks.description",
    side: "right",
  },
  {
    scope: "project",
    anchor: "siteEditor",
    titleKey: "layoutTour.siteEditor.title",
    descKey: "layoutTour.siteEditor.description",
    side: "right",
  },
  {
    scope: "project",
    anchor: "automations",
    titleKey: "layoutTour.automations.title",
    descKey: "layoutTour.automations.description",
    side: "right",
  },
  {
    /** SHELL, not project: this row renders in both scopes, and its copy is
     *  about the fact that it has two targets — which is exactly the thing an
     *  org-home reader also needs told. */
    scope: "shell",
    anchor: "settings",
    titleKey: "layoutTour.settings.title",
    descKey: "layoutTour.settings.description",
    side: "right",
  },
  {
    /** SHELL, not orgHome: the project list is sidebar furniture now, present
     *  on every route. It used to be the org home's panel content, which is why
     *  this step sat at the end with the panel steps. */
    scope: "shell",
    anchor: "projects",
    titleKey: "layoutTour.projects.title",
    descKey: "layoutTour.projects.description",
    side: "right",
  },
  {
    scope: "shell",
    anchor: "account",
    titleKey: "layoutTour.account.title",
    descKey: "layoutTour.account.description",
    side: "right",
  },
  {
    scope: "siteEditor",
    anchor: "surfaceTabs",
    titleKey: "layoutTour.surfaceTabs.title",
    descKey: "layoutTour.surfaceTabs.description",
    side: "bottom",
  },
  {
    scope: "siteEditor",
    anchor: "branchPicker",
    titleKey: "layoutTour.branchPicker.title",
    descKey: "layoutTour.branchPicker.description",
    side: "bottom",
  },
  {
    scope: "orgHome",
    anchor: "recentActivity",
    titleKey: "layoutTour.recentActivity.title",
    descKey: "layoutTour.recentActivity.description",
    side: "top",
  },
];

/** The steps whose scope matches this route, in STEP_DEFS order. Anchor
 *  visibility is a SEPARATE filter applied at launch — this one answers "does
 *  this step belong on this screen", not "is its control painted yet". */
export function stepsForRoute(route: TourRoute): StepDef[] {
  return STEP_DEFS.filter(
    (step) =>
      step.scope === "shell" ||
      (step.scope === "orgHome" && route.onOrgHome) ||
      (step.scope === "project" && route.inProject) ||
      (step.scope === "siteEditor" && route.onSiteEditor),
  );
}

export function buildSteps(t: TFunction, route: TourRoute): DriveStep[] {
  /** Every value handed to a popover (title/description/button text) MUST be a
   *  static i18n string: driver.js renders title and description via innerHTML,
   *  so interpolating dynamic content (org or agent names) here would be an XSS
   *  sink. */
  return stepsForRoute(route).map((step) => ({
    element: layoutTourAnchorSelector(step.anchor),
    popover: {
      title: t(step.titleKey),
      description: t(step.descKey),
      side: step.side,
      align: "center",
    },
  }));
}
