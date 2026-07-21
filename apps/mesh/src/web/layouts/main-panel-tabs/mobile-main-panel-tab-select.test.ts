import { describe, expect, test } from "bun:test";
import { resolveMobileMainPanelTabSelectLabel } from "./mobile-main-panel-tab-select";
import { en } from "@/web/i18n/en/index.ts";
import type { TranslationKey } from "@/web/i18n/en/index.ts";

const t = (key: TranslationKey) => en[key];

const tabs = [
  { id: "preview", title: "Preview" },
  { id: "settings", title: "Settings" },
];

describe("resolveMobileMainPanelTabSelectLabel", () => {
  test("shows the active tab while the main panel is open", () => {
    expect(
      resolveMobileMainPanelTabSelectLabel({
        tabs,
        activeTab: "settings",
        mainOpen: true,
        t,
      }),
    ).toBe("Settings");
  });

  test("shows Main view for transient open tabs that are not selectable", () => {
    expect(
      resolveMobileMainPanelTabSelectLabel({
        tabs,
        activeTab: "file:model-output%2Fpreview.pdf",
        mainOpen: true,
        t,
      }),
    ).toBe("Main view");
  });

  test("shows the default active tab while the main panel is closed", () => {
    expect(
      resolveMobileMainPanelTabSelectLabel({
        tabs,
        activeTab: "settings",
        mainOpen: false,
        t,
      }),
    ).toBe("Settings");
  });

  test("falls back to the first tab while closed when the default tab is unavailable", () => {
    expect(
      resolveMobileMainPanelTabSelectLabel({
        tabs,
        activeTab: "git",
        mainOpen: false,
        t,
      }),
    ).toBe("Preview");
  });

  test("falls back to Main view when there are no tabs", () => {
    expect(
      resolveMobileMainPanelTabSelectLabel({
        tabs: [],
        activeTab: "settings",
        mainOpen: false,
        t,
      }),
    ).toBe("Main view");
  });
});
