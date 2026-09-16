import { describe, expect, test } from "bun:test";
import { resolvePanelNavigationSearch } from "@/layouts/main-panel-tabs/panel-navigation-search";
import {
  isProjectSettingsSectionKey,
  PROJECT_SETTINGS_SECTION_KEYS,
  PROJECT_SETTINGS_SECTIONS,
} from "./sections";

describe("project settings sections", () => {
  test("every key names its tab", () => {
    for (const key of PROJECT_SETTINGS_SECTION_KEYS) {
      expect(PROJECT_SETTINGS_SECTIONS[key].titleKey).toBeString();
    }
  });

  test("only known tabs are accepted", () => {
    expect(isProjectSettingsSectionKey(undefined)).toBe(false);
    expect(isProjectSettingsSectionKey("")).toBe(false);
    expect(isProjectSettingsSectionKey("layout")).toBe(false);
    expect(isProjectSettingsSectionKey("general")).toBe(true);
  });

  /** The views settings moved into General, so a link someone saved while they
   *  were their own tab still lands on the page that shows them. */
  test("a stale Views link falls back to General, which now holds them", () => {
    expect(isProjectSettingsSectionKey("views")).toBe(false);
  });

  test("leaving Settings drops its section selection", () => {
    const next = resolvePanelNavigationSearch({
      previous: { section: "general", thread: "thread-1", sidepanel: true },
      destination: "agent",
    });
    expect(next).not.toHaveProperty("section");
    expect(next.thread).toBe("thread-1");
  });
});
