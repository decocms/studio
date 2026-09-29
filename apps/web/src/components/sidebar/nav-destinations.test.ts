import { describe, expect, test } from "bun:test";
import { NAV_DESTINATION_KEYS, SETTINGS_DESTINATION } from "./nav-destinations";

/** `NavDestinationsContent` maps over `NAV_DESTINATION_KEYS`, so this constant
 *  IS the render order rather than a description of it. */
describe("NAV_DESTINATION_KEYS", () => {
  test("is the org's three destinations, in order", () => {
    expect(NAV_DESTINATION_KEYS).toEqual(["overview", "tasks", "agents"]);
  });

  /** Reports and the Library are reached from Today or from a project, not the spine. */
  test("holds nothing that is reachable from inside another destination", () => {
    for (const key of ["reports", "files", "library", "discover"]) {
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

  test("is not one of the spine's rows", () => {
    expect(NAV_DESTINATION_KEYS).not.toContain(SETTINGS_DESTINATION);
  });
});
