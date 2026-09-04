import { describe, expect, test } from "bun:test";
import { NAV_DESTINATION_KEYS, SETTINGS_DESTINATION } from "./nav-destinations";

describe("organization navigation", () => {
  test("keeps every organization-owned destination in a stable order", () => {
    expect(NAV_DESTINATION_KEYS).toEqual([
      "overview",
      "reports",
      "board",
      "files",
    ]);
  });

  test("keeps Settings separate and preserves its analytics key", () => {
    expect(SETTINGS_DESTINATION).toBe("settings");
    expect(NAV_DESTINATION_KEYS).not.toContain(SETTINGS_DESTINATION);
  });
});
