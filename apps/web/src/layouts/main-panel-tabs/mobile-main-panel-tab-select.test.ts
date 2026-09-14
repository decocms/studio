import { describe, expect, test } from "bun:test";
import {
  resolveMobileMainPanelSelection,
  resolveMobileMainPanelTabSelectLabel,
  resolveMobileMainPanelTriggerOption,
  resolveMobileMainPanelViewOptions,
  restoreCurrentMobileMainSearch,
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

describe("resolveMobileMainPanelSelection", () => {
  test("selects Chat when an explicit side panel wins over an open main panel", () => {
    expect(
      resolveMobileMainPanelSelection({
        activeTab: "site-editor",
        sidePanelOpen: true,
        mainOpen: true,
        sidePanelParamPresent: true,
      }),
    ).toEqual({ value: "chat", surface: "chat" });
  });

  test("selects the route-owned view on the main surface", () => {
    expect(
      resolveMobileMainPanelSelection({
        activeTab: "site-editor",
        sidePanelOpen: true,
        mainOpen: true,
        sidePanelParamPresent: false,
      }),
    ).toEqual({ value: "site-editor", surface: "main" });
  });

  test("restores the mounted Content route without dropping its deep link", () => {
    expect(
      restoreCurrentMobileMainSearch({
        thread: "thread-1",
        sidepanel: true,
        mainpanel: false,
        contentPageId: "page-product-42",
        contentPath: "/products/café?variant=blue",
        contentPathTemplate: "/products/:slug",
      }),
    ).toEqual({
      thread: "thread-1",
      sidepanel: false,
      mainpanel: true,
      contentPageId: "page-product-42",
      contentPath: "/products/café?variant=blue",
      contentPathTemplate: "/products/:slug",
    });
  });
});

describe("resolveMobileMainPanelTriggerOption", () => {
  test("renders the controlled Chat option while Chat is visible", () => {
    const options = resolveMobileMainPanelViewOptions({
      tabs: [],
      activeTab: "overview",
      currentRouteTitle: "Project Alpha",
      orgSlug: "acme",
      titles: {
        chat: "Chat",
        tasks: "Tasks",
        library: "Library",
        mainView: "Main view",
      },
    });
    const selection = resolveMobileMainPanelSelection({
      activeTab: "overview",
      sidePanelOpen: true,
      mainOpen: true,
      sidePanelParamPresent: true,
    });

    expect(selection).toEqual({ value: "chat", surface: "chat" });
    expect(
      resolveMobileMainPanelTriggerOption({
        options,
        value: selection.value,
      }),
    ).toMatchObject({ value: "chat", title: "Chat" });
  });
});

describe("resolveMobileMainPanelViewOptions", () => {
  test("keeps Tasks and Library available after switching to Chat clears the thread", () => {
    const options = resolveMobileMainPanelViewOptions({
      tabs: [],
      activeTab: "board",
      orgSlug: "acme",
      titles: {
        chat: "Chat",
        tasks: "Tasks",
        library: "Library",
        mainView: "Main view",
      },
    });

    expect(options.map(({ value }) => value)).toEqual([
      "chat",
      "board",
      "files",
    ]);
  });

  test("hides organization destinations outside an organization", () => {
    const options = resolveMobileMainPanelViewOptions({
      tabs: [],
      activeTab: "chat",
      orgSlug: undefined,
      titles: {
        chat: "Chat",
        tasks: "Tasks",
        library: "Library",
        mainView: "Main view",
      },
    });

    expect(options.map(({ value }) => value)).toEqual(["chat"]);
  });

  test("omits the organization Library inside a project", () => {
    const options = resolveMobileMainPanelViewOptions({
      tabs: [],
      activeTab: "board",
      orgSlug: "acme",
      projectScoped: true,
      titles: {
        chat: "Chat",
        tasks: "Tasks",
        library: "Library",
        mainView: "Main view",
      },
    });

    expect(options.map(({ value }) => value)).toEqual(["chat", "board"]);
  });

  test("keeps the current route selectable after switching to Chat", () => {
    const options = resolveMobileMainPanelViewOptions({
      tabs: [],
      activeTab: "settings",
      currentRouteTitle: "Settings",
      orgSlug: "acme",
      titles: {
        chat: "Chat",
        tasks: "Tasks",
        library: "Library",
        mainView: "Main view",
      },
    });

    expect(options.map(({ value, title }) => ({ value, title }))).toEqual([
      { value: "chat", title: "Chat" },
      { value: "settings", title: "Settings" },
      { value: "board", title: "Tasks" },
      { value: "files", title: "Library" },
    ]);
  });

  test("names a source-less Site Editor route with no surface tabs", () => {
    const options = resolveMobileMainPanelViewOptions({
      tabs: [],
      activeTab: "site-editor",
      currentRouteTitle: "Site Editor",
      orgSlug: "acme",
      titles: {
        chat: "Chat",
        tasks: "Tasks",
        library: "Library",
        mainView: "Main view",
      },
    });

    expect(options[1]).toMatchObject({
      value: "site-editor",
      title: "Site Editor",
    });
  });

  test("keeps a source-less agent Overview identified as the mounted route", () => {
    const options = resolveMobileMainPanelViewOptions({
      tabs: [],
      activeTab: "overview",
      currentRouteTitle: "Project Alpha",
      orgSlug: "acme",
      titles: {
        chat: "Chat",
        tasks: "Tasks",
        library: "Library",
        mainView: "Main view",
      },
    });

    expect(options[1]).toMatchObject({
      value: "overview",
      title: "Project Alpha",
    });
  });

  test("represents an unresolved deep link with a real selectable option", () => {
    const options = resolveMobileMainPanelViewOptions({
      tabs: [],
      activeTab: "file",
      orgSlug: "acme",
      titles: {
        chat: "Chat",
        tasks: "Tasks",
        library: "Library",
        mainView: "Main view",
      },
    });

    expect(options[1]).toMatchObject({ value: "file", title: "Main view" });
  });
});
