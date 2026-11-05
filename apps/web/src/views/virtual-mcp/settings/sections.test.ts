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

  /** Views is its own section again, so a saved Views link opens it. */
  test("a Views link opens the Views section", () => {
    expect(isProjectSettingsSectionKey("views")).toBe(true);
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
