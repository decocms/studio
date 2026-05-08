import { describe, expect, test } from "bun:test";
import {
  isLegacySettingsTab,
  parseAutomationTabId,
  resolveDefaultTabId,
  resolveActiveTabAndOpen,
  resolveTabClickTarget,
  isAutomationsPillActive,
  resolveAutomationsPillClickTarget,
} from "./tab-id";

describe("parseAutomationTabId", () => {
  test("automation:<uuid> → { id }", () => {
    expect(parseAutomationTabId("automation:abc-123")).toEqual({
      id: "abc-123",
    });
  });

  test("non-automation tab → null", () => {
    expect(parseAutomationTabId("settings")).toBeNull();
    expect(parseAutomationTabId("preview")).toBeNull();
    expect(parseAutomationTabId(undefined)).toBeNull();
    expect(parseAutomationTabId("0")).toBeNull();
  });

  test("automation: with empty id → null", () => {
    expect(parseAutomationTabId("automation:")).toBeNull();
  });
});

describe("isLegacySettingsTab", () => {
  test("legacy tab ids → true", () => {
    expect(isLegacySettingsTab("instructions")).toBe(true);
    expect(isLegacySettingsTab("connections")).toBe(true);
    expect(isLegacySettingsTab("layout")).toBe(true);
    expect(isLegacySettingsTab("settings")).toBe(true);
  });

  test("non-legacy tab ids → false", () => {
    expect(isLegacySettingsTab("automations")).toBe(false);
    expect(isLegacySettingsTab("env")).toBe(false);
    expect(isLegacySettingsTab("preview")).toBe(false);
    expect(isLegacySettingsTab("git")).toBe(false);
    expect(isLegacySettingsTab(undefined)).toBe(false);
  });
});

describe("resolveDefaultTabId", () => {
  test("null metadata → 'settings'", () => {
    expect(resolveDefaultTabId(null)).toBe("settings");
  });

  test("defaultMainView null → 'settings'", () => {
    expect(resolveDefaultTabId({ defaultMainView: null })).toBe("settings");
  });

  test("ext-app with id → id", () => {
    expect(
      resolveDefaultTabId({
        defaultMainView: { type: "ext-app", id: "analytics" },
        tabs: [{ id: "analytics" }],
      }),
    ).toBe("analytics");
  });

  test("ext-app no id → first declared tab id", () => {
    expect(
      resolveDefaultTabId({
        defaultMainView: { type: "ext-app" },
        tabs: [{ id: "t1" }, { id: "t2" }],
      }),
    ).toBe("t1");
  });

  test("ext-app id not in declared tabs → first declared tab id", () => {
    expect(
      resolveDefaultTabId({
        defaultMainView: { type: "ext-app", id: "stale" },
        tabs: [{ id: "t1" }, { id: "t2" }],
      }),
    ).toBe("t1");
  });

  test("ext-app id not in declared tabs and no tabs → 'settings'", () => {
    expect(
      resolveDefaultTabId({
        defaultMainView: { type: "ext-app", id: "stale" },
        tabs: [],
      }),
    ).toBe("settings");
  });

  test("ext-apps with id + toolName → pinned-view tab id", () => {
    expect(
      resolveDefaultTabId({
        defaultMainView: {
          type: "ext-apps",
          id: "conn-abc",
          toolName: "hello_world",
        },
        tabs: [],
      }),
    ).toBe("app:conn-abc:hello_world");
  });

  test("legacy instructions → 'settings'", () => {
    expect(
      resolveDefaultTabId({ defaultMainView: { type: "instructions" } }),
    ).toBe("settings");
  });

  test("legacy connections → 'settings'", () => {
    expect(
      resolveDefaultTabId({ defaultMainView: { type: "connections" } }),
    ).toBe("settings");
  });

  test("legacy layout → 'settings'", () => {
    expect(resolveDefaultTabId({ defaultMainView: { type: "layout" } })).toBe(
      "settings",
    );
  });

  test("env → 'env'", () => {
    expect(resolveDefaultTabId({ defaultMainView: { type: "env" } })).toBe(
      "env",
    );
  });

  test("preview → 'preview'", () => {
    expect(resolveDefaultTabId({ defaultMainView: { type: "preview" } })).toBe(
      "preview",
    );
  });

  test("git → 'git'", () => {
    expect(resolveDefaultTabId({ defaultMainView: { type: "git" } })).toBe(
      "git",
    );
  });

  test("unknown type falls back to 'settings'", () => {
    expect(
      resolveDefaultTabId({ defaultMainView: { type: "automation" } }),
    ).toBe("settings");
  });
});

describe("resolveActiveTabAndOpen", () => {
  const meta = {
    defaultMainView: { type: "ext-app", id: "analytics" },
    tabs: [{ id: "analytics" }],
  };

  test("?main absent + defaultMainView set → open, tab = default", () => {
    expect(
      resolveActiveTabAndOpen({ mainParam: undefined, metadata: meta }),
    ).toEqual({ mainOpen: true, activeTab: "analytics" });
  });

  test("?main absent + no defaultMainView → closed, tab = 'settings'", () => {
    expect(
      resolveActiveTabAndOpen({ mainParam: undefined, metadata: null }),
    ).toEqual({ mainOpen: false, activeTab: "settings" });
  });

  test("?main absent + defaultMainView.type === 'chat' → closed (aligns with resolveDefaultPanelState)", () => {
    expect(
      resolveActiveTabAndOpen({
        mainParam: undefined,
        metadata: { defaultMainView: { type: "chat" } },
      }),
    ).toEqual({ mainOpen: false, activeTab: "settings" });
  });

  test("?main=0 → closed, tab = default", () => {
    expect(resolveActiveTabAndOpen({ mainParam: "0", metadata: meta })).toEqual(
      { mainOpen: false, activeTab: "analytics" },
    );
  });

  test("?main=settings → open, tab = 'settings'", () => {
    expect(
      resolveActiveTabAndOpen({ mainParam: "settings", metadata: meta }),
    ).toEqual({ mainOpen: true, activeTab: "settings" });
  });

  test("?main=instructions (legacy) → open, tab = 'settings'", () => {
    expect(
      resolveActiveTabAndOpen({ mainParam: "instructions", metadata: meta }),
    ).toEqual({ mainOpen: true, activeTab: "settings" });
  });

  test("?main=connections (legacy) → open, tab = 'settings'", () => {
    expect(
      resolveActiveTabAndOpen({ mainParam: "connections", metadata: meta }),
    ).toEqual({ mainOpen: true, activeTab: "settings" });
  });

  test("?main=layout (legacy) → open, tab = 'settings'", () => {
    expect(
      resolveActiveTabAndOpen({ mainParam: "layout", metadata: meta }),
    ).toEqual({ mainOpen: true, activeTab: "settings" });
  });

  test("?main=automation:abc → open, tab = 'automation:abc'", () => {
    expect(
      resolveActiveTabAndOpen({
        mainParam: "automation:abc",
        metadata: meta,
      }),
    ).toEqual({ mainOpen: true, activeTab: "automation:abc" });
  });

  test("?main=git → open, tab = 'git'", () => {
    expect(
      resolveActiveTabAndOpen({ mainParam: "git", metadata: meta }),
    ).toEqual({ mainOpen: true, activeTab: "git" });
  });
});

describe("resolveTabClickTarget", () => {
  test("clicking active tab while panel open → close ('0')", () => {
    expect(
      resolveTabClickTarget({
        clickedId: "settings",
        activeTab: "settings",
        mainOpen: true,
      }),
    ).toBe("0");
  });

  test("clicking non-active tab while panel open → clicked id", () => {
    expect(
      resolveTabClickTarget({
        clickedId: "env",
        activeTab: "settings",
        mainOpen: true,
      }),
    ).toBe("env");
  });

  test("clicking any tab while panel closed → clicked id (open it)", () => {
    expect(
      resolveTabClickTarget({
        clickedId: "settings",
        activeTab: "settings",
        mainOpen: false,
      }),
    ).toBe("settings");
    expect(
      resolveTabClickTarget({
        clickedId: "preview",
        activeTab: "settings",
        mainOpen: false,
      }),
    ).toBe("preview");
  });
});

describe("isAutomationsPillActive", () => {
  test("activeTab='automations' and panel open → true", () => {
    expect(
      isAutomationsPillActive({ activeTab: "automations", mainOpen: true }),
    ).toBe(true);
  });

  test("activeTab='automation:abc' and panel open → true", () => {
    expect(
      isAutomationsPillActive({ activeTab: "automation:abc", mainOpen: true }),
    ).toBe(true);
  });

  test("activeTab='automation:new' and panel open → true", () => {
    expect(
      isAutomationsPillActive({ activeTab: "automation:new", mainOpen: true }),
    ).toBe(true);
  });

  test("panel closed → false even when activeTab matches", () => {
    expect(
      isAutomationsPillActive({ activeTab: "automations", mainOpen: false }),
    ).toBe(false);
    expect(
      isAutomationsPillActive({ activeTab: "automation:abc", mainOpen: false }),
    ).toBe(false);
  });

  test("non-automation tab → false", () => {
    expect(
      isAutomationsPillActive({ activeTab: "settings", mainOpen: true }),
    ).toBe(false);
    expect(
      isAutomationsPillActive({ activeTab: "preview", mainOpen: true }),
    ).toBe(false);
  });
});

describe("resolveAutomationsPillClickTarget", () => {
  test("panel closed → open the list", () => {
    expect(
      resolveAutomationsPillClickTarget({
        activeTab: "automations",
        mainOpen: false,
      }),
    ).toBe("automations");
  });

  test("on detail (automation:<id>) → navigate up to list", () => {
    expect(
      resolveAutomationsPillClickTarget({
        activeTab: "automation:abc",
        mainOpen: true,
      }),
    ).toBe("automations");
  });

  test("on detail (automation:new) → navigate up to list", () => {
    expect(
      resolveAutomationsPillClickTarget({
        activeTab: "automation:new",
        mainOpen: true,
      }),
    ).toBe("automations");
  });

  test("on list while panel open → close ('0')", () => {
    expect(
      resolveAutomationsPillClickTarget({
        activeTab: "automations",
        mainOpen: true,
      }),
    ).toBe("0");
  });

  test("on unrelated tab → open list", () => {
    expect(
      resolveAutomationsPillClickTarget({
        activeTab: "settings",
        mainOpen: true,
      }),
    ).toBe("automations");
  });
});
