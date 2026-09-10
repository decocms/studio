import { describe, expect, test } from "bun:test";
import { PANEL_PAYLOAD_KEYS } from "@/layouts/main-panel-tabs/panel-route";
import {
  isProjectSettingsSectionKey,
  PROJECT_SETTINGS_SECTION_KEYS,
  PROJECT_SETTINGS_SECTIONS,
} from "./sections";

describe("project settings sections", () => {
  test("every key has a title and a description", () => {
    for (const key of PROJECT_SETTINGS_SECTION_KEYS) {
      expect(PROJECT_SETTINGS_SECTIONS[key].titleKey).toBeString();
      expect(PROJECT_SETTINGS_SECTIONS[key].descriptionKey).toBeString();
    }
  });

  test("an unknown or absent value lands on the index, not a blank page", () => {
    expect(isProjectSettingsSectionKey(undefined)).toBe(false);
    expect(isProjectSettingsSectionKey("")).toBe(false);
    expect(isProjectSettingsSectionKey("layout")).toBe(false);
    /** The views are listed on the index, so `views` is not a section. */
    expect(isProjectSettingsSectionKey("views")).toBe(false);
    expect(isProjectSettingsSectionKey("general")).toBe(true);
  });

  test("`section` is a registered panel payload key, so leaving Settings drops it", () => {
    expect(PANEL_PAYLOAD_KEYS).toContain("section");
  });
});
