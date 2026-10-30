import { describe, expect, test } from "bun:test";
import {
  NAV_DESTINATION_KEYS,
  SETTINGS_DESTINATION,
  navDestinationKeys,
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
