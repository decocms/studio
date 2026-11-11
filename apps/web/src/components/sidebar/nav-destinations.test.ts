import { describe, expect, test } from "bun:test";
import { PROJECT_NAV_VIEW_IDS } from "@/layouts/main-panel-tabs/project-sidebar-views";
import {
  NAV_DESTINATION_KEYS,
  NAV_DESTINATION_VIEW,
  SETTINGS_DESTINATION,
  navDestinationKeys,
  visibleNavDestinationKeys,
} from "./nav-destinations";

/** `NavDestinationsContent` maps over `NAV_DESTINATION_KEYS`, so this constant
 *  IS the render order rather than a description of it. */
describe("NAV_DESTINATION_KEYS", () => {
  test("is the org's destinations, in order", () => {
    expect(NAV_DESTINATION_KEYS).toEqual([
      "overview",
      "files",
      "monitor",
      "plan",
      "tasks",
    ]);
  });

  /** Reports is reached from Today or from a project, not the spine. */
  test("holds nothing that is reachable from inside another destination", () => {
    for (const key of ["reports", "discover"]) {
      expect(NAV_DESTINATION_KEYS).not.toContain(key);
    }
  });
});

describe("SETTINGS_DESTINATION", () => {
  /** PostHog dashboards key on this exact value; the row it named is gone but
   *  whatever replaces it reports as the same destination. */
  test("keeps its analytics value", () => {
    expect(SETTINGS_DESTINATION).toBe("settings");
  });

  test("is not one of the org's rows", () => {
    expect(navDestinationKeys(false)).not.toContain(SETTINGS_DESTINATION);
  });

  /** A project's settings left its Context, so the project spine ends on them. */
  test("is the last of a project's rows", () => {
    expect(navDestinationKeys(true).at(-1)).toBe(SETTINGS_DESTINATION);
  });
});

describe("visibleNavDestinationKeys", () => {
  /** Settings › Views lists the top rows in this same order. */
  test("maps each row to its project view, in order", () => {
    expect(
      NAV_DESTINATION_KEYS.map((key) => NAV_DESTINATION_VIEW[key]),
    ).toEqual([...PROJECT_NAV_VIEW_IDS]);
  });

  test("drops the rows a project hides, but never its Settings", () => {
    expect(visibleNavDestinationKeys(true, new Set(["monitor"]))).toEqual([
      "monitor",
      SETTINGS_DESTINATION,
    ]);
    expect(visibleNavDestinationKeys(true, new Set())).toEqual([
      SETTINGS_DESTINATION,
    ]);
  });

  /** A project's choice is its own: the org's rows stay whole. */
  test("shows every org row", () => {
    expect(visibleNavDestinationKeys(false, new Set())).toEqual([
      ...NAV_DESTINATION_KEYS,
    ]);
  });
});
