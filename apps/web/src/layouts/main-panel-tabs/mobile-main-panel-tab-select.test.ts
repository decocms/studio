import { describe, expect, test } from "bun:test";
import {
  buildMobileViewOptions,
  MAIN_SURFACE_VALUE,
  resolveMobileMainPanelTabSelectLabel,
} from "./mobile-main-panel-tab-select";
import { en } from "@/i18n/en/index.ts";
import type { TranslationKey } from "@/i18n/en/index.ts";

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

const icon = { kind: "component", Component: () => null } as const;
const iconTabs = tabs.map((tab) => ({ ...tab, icon }));

describe("buildMobileViewOptions", () => {
  test("offers the main surface back when the route declares no tabs", () => {
    expect(
      buildMobileViewOptions({ tabs: [], overlayEnabled: false, t }).map(
        (option) => option.value,
      ),
    ).toEqual(["chat", MAIN_SURFACE_VALUE]);
  });

  test("does not synthesize a main row when tabs already lead back", () => {
    expect(
      buildMobileViewOptions({
        tabs: iconTabs,
        overlayEnabled: false,
        t,
      }).map((option) => option.value),
    ).toEqual(["chat", "preview", "settings"]);
  });

  test("adds the Tasks and Library overlays on a task route", () => {
    expect(
      buildMobileViewOptions({ tabs: [], overlayEnabled: true, t }).map(
        (option) => option.value,
      ),
    ).toEqual(["chat", MAIN_SURFACE_VALUE, "board", "files"]);
  });

  test("names the main row, so it is pickable rather than only a label", () => {
    const options = buildMobileViewOptions({
      tabs: [],
      overlayEnabled: false,
      t,
    });
    expect(
      options.find((option) => option.value === MAIN_SURFACE_VALUE)?.title,
    ).toBe("Main view");
  });
});
