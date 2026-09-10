import { describe, expect, test } from "bun:test";
import { STEP_DEFS, buildSteps, stepsForRoute, type TourRoute } from "./steps";
import { LAYOUT_TOUR_ANCHORS, layoutTourAnchorSelector } from "./anchors";

// A stub t() that echoes the key, so we can assert wiring without the real dict.
const t = ((key: string) => key) as unknown as Parameters<typeof buildSteps>[0];

const ORG_HOME: TourRoute = {
  onOrgHome: true,
  inProject: false,
  onSiteEditor: false,
};
/** A project route that is NOT the Site Editor — its home, say. */
const PROJECT: TourRoute = {
  onOrgHome: false,
  inProject: true,
  onSiteEditor: false,
};
const SITE_EDITOR: TourRoute = {
  onOrgHome: false,
  inProject: true,
  onSiteEditor: true,
};
const ELSEWHERE: TourRoute = {
  onOrgHome: false,
  inProject: false,
  onSiteEditor: false,
};

describe("layout-tour steps", () => {
  /** The spotlight walks the screen: down the sidebar, then into the panel.
   *  Scope is a FILTER, not the sort key — asserting the whole sequence is what
   *  stops a new step being appended by scope and making the tour hop. */
  test("steps are ordered by position on screen, not by scope", () => {
    expect(STEP_DEFS.map((s) => s.anchor)).toEqual([
      // sidebar, top to bottom
      "switcher",
      "nav",
      "tasks",
      "siteEditor",
      "automations",
      "settings",
      "projects",
      "account",
      // then the main panel
      "surfaceTabs",
      "branchPicker",
      "recentActivity",
    ]);
  });

  test("the shell steps are the ones that run everywhere", () => {
    expect(
      STEP_DEFS.filter((s) => s.scope === "shell").map((s) => s.anchor),
    ).toEqual(["switcher", "nav", "tasks", "settings", "projects", "account"]);
  });

  test("every step anchor is a real LAYOUT_TOUR_ANCHORS entry", () => {
    for (const step of STEP_DEFS) {
      expect(LAYOUT_TOUR_ANCHORS[step.anchor]).toBeDefined();
    }
  });

  test("anchor names are unique and namespaced to this tour", () => {
    const names = Object.values(LAYOUT_TOUR_ANCHORS);
    expect(new Set(names).size).toBe(names.length);
    for (const name of names) {
      expect(name.startsWith("tour-layout-")).toBe(true);
    }
  });

  /** The tour no longer navigates, so a route with no surface of its own must
   *  still produce a usable tour rather than nothing. */
  test("a route with neither surface still gets the whole shell", () => {
    expect(stepsForRoute(ELSEWHERE).map((s) => s.anchor)).toEqual([
      "switcher",
      "nav",
      "tasks",
      "settings",
      "projects",
      "account",
    ]);
  });

  test("the org home adds its own steps and no project ones", () => {
    const anchors = stepsForRoute(ORG_HOME).map((s) => s.anchor);
    expect(anchors).toContain("recentActivity");
    expect(anchors).not.toContain("siteEditor");
    expect(anchors).not.toContain("branchPicker");
  });

  /** Sidebar first and in physical order — the project rows sit between the
   *  destinations and Settings, and the account button stays last in the
   *  sidebar — then the panel. */
  test("a project walks the sidebar before the panel", () => {
    const anchors = stepsForRoute(SITE_EDITOR).map((s) => s.anchor);
    expect(anchors).toEqual([
      "switcher",
      "nav",
      "tasks",
      "siteEditor",
      "automations",
      "settings",
      "projects",
      "account",
      "surfaceTabs",
      "branchPicker",
    ]);
  });

  /** The tab bar and the branch selector are mounted WITH the Site Editor, so
   *  a project route that is not it (the project home, say) must not spotlight
   *  controls that are not on screen — `skipMissingElement` would swallow them
   *  silently, which is exactly the bug this asserts against. */
  test("a project outside the Site Editor drops its two surface steps", () => {
    const anchors = stepsForRoute(PROJECT).map((s) => s.anchor);
    expect(anchors).toEqual([
      "switcher",
      "nav",
      "tasks",
      "siteEditor",
      "automations",
      "settings",
      "projects",
      "account",
    ]);
    expect(anchors).not.toContain("surfaceTabs");
    expect(anchors).not.toContain("branchPicker");
  });

  test("the org home ends on the panel, after the sidebar", () => {
    expect(stepsForRoute(ORG_HOME).map((s) => s.anchor)).toEqual([
      "switcher",
      "nav",
      "tasks",
      "settings",
      "projects",
      "account",
      "recentActivity",
    ]);
  });

  test("buildSteps resolves each anchor to its data-tour selector", () => {
    const defs = stepsForRoute(ORG_HOME);
    const steps = buildSteps(t, ORG_HOME);
    expect(steps).toHaveLength(defs.length);
    steps.forEach((step, i) => {
      expect(step.element).toBe(layoutTourAnchorSelector(defs[i]!.anchor));
      // popover carries the (stubbed) i18n keys, proving title/description wiring
      expect(step.popover?.title).toBe(defs[i]!.titleKey);
      expect(step.popover?.description).toBe(defs[i]!.descKey);
    });
  });
});
